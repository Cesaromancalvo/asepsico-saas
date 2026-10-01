import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ClinicalProcessStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { encryptField } from '../common/crypto/field-encryption';
import { decryptProcess, decryptSession } from '../common/crypto/clinical-crypto';
import { ClinicalAccessService } from '../clinical-access/clinical-access.service';
import { CreateClinicalProcessDto } from './dto/create-clinical-process.dto';
import { UpdateClinicalProcessDto } from './dto/update-clinical-process.dto';
import { ClinicalProcessStatusValue } from './dto/change-clinical-process-status.dto';
import { ListClinicalProcessesQueryDto } from './dto/list-clinical-processes-query.dto';
import { PATIENT_VIEW_SELECT, projectSelect, toPatientView } from '../patients/patient-view.util';
import { SESSION_SUMMARY_SELECT } from '../sessions/session-view.util';

// Roles que entran en este módulo. ASSISTANT nunca. OWNER/ADMIN entran para operaciones
// ADMINISTRATIVAS (quién atiende a quién, estado, reasignación); el contenido clínico del proceso
// lo decide ClinicalAccessService (clínico con proceso activo, o autor para lo suyo).
const CLINICAL_ACCESS_ROLES = ['OWNER', 'ADMIN', 'THERAPIST'];
const ADMIN_ROLES = ['OWNER', 'ADMIN'];

// Campos de contenido clínico del proceso (el título también: puede revelar el motivo).
const CLINICAL_FIELDS = ['title', 'consultationReason', 'goals', 'internalNotes'] as const;

/** Vista administrativa de un proceso: sin título ni narrativa clínica. */
const CLINICAL_PROCESS_ADMIN_SELECT = {
  id: true, workspaceId: true, patientId: true, therapistId: true, modality: true, frequency: true,
  status: true, startedAt: true, endedAt: true, createdAt: true, updatedAt: true,
} as const;

// CLOSED es terminal a propósito: si un proceso se cierra por error no se "deshace" reabriéndolo,
// se documenta y se abre uno nuevo. DISCHARGED sí puede reabrirse (el paciente vuelve a consulta).
const ALLOWED_TRANSITIONS: Record<ClinicalProcessStatus, ClinicalProcessStatusValue[]> = {
  ACTIVE: ['PAUSED', 'DISCHARGED', 'CLOSED'],
  PAUSED: ['ACTIVE', 'DISCHARGED', 'CLOSED'],
  DISCHARGED: ['ACTIVE'],
  CLOSED: [],
};

// consultationReason, goals e internalNotes se cifran en reposo (lista única en
// common/crypto/clinical-crypto.ts).

/**
 * Fila de GET /clinical-processes (listado). Sin consultationReason, goals ni internalNotes y
 * con las sesiones solo como metadatos (sin notes ni internalSummary): los listados nunca
 * devuelven narrativa clínica (regla dura 2). El contenido completo está en GET /clinical-processes/:id.
 */
const CLINICAL_PROCESS_LIST_SELECT = {
  id: true,
  workspaceId: true,
  patientId: true,
  therapistId: true,
  title: true,
  modality: true,
  frequency: true,
  status: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
  patient: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
  therapist: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { sessions: true } },
} as const satisfies Prisma.ClinicalProcessSelect;

const CLINICAL_PROCESS_LIST_PROJECTION = { ...CLINICAL_PROCESS_LIST_SELECT, sessions: { select: SESSION_SUMMARY_SELECT } };

@Injectable()
export class ClinicalProcessesService {
  private readonly access: ClinicalAccessService;

  constructor(private prisma: PrismaService, @Optional() access?: ClinicalAccessService) {
    this.access = access ?? new ClinicalAccessService(prisma);
  }

  async list(workspaceId: string, actor: AuthUser, query: ListClinicalProcessesQueryDto) {
    this.assertClinicalAccess(actor);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const { isClinician, treatingPatientIds } = await this.access.listingContext(workspaceId, actor);
    const treating = [...treatingPatientIds];
    // Procesos cuyo contenido (título incluido) puede leer: los suyos y los de pacientes que trata.
    const readable: Prisma.ClinicalProcessWhereInput = isClinician
      ? { OR: [{ therapistId: actor.sub }, { patientId: { in: treating } }] }
      : { id: { in: [] } };

    const where: Prisma.ClinicalProcessWhereInput = {
      workspaceId,
      // Un THERAPIST solo lista los suyos y los de pacientes que trata (sea cual sea el
      // therapistId que pida por query). OWNER/ADMIN listan todos, como vista administrativa.
      ...(actor.role === 'THERAPIST' ? { AND: [{ OR: [{ therapistId: actor.sub }, { patientId: { in: treating } }] }] } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(query.therapistId ? { therapistId: query.therapistId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              // Buscar por título solo dentro de lo que puede leer (si no, el filtro revelaría
              // el título de procesos ajenos).
              { AND: [readable, { title: { contains: query.q, mode: 'insensitive' } }] },
              // No se busca dentro de consultationReason: al estar cifrado en la base de
              // datos, un "contains" sobre el texto cifrado nunca encontraría coincidencias
              // reales y daría resultados silenciosamente incompletos. Si en el futuro hace
              // falta buscar por contenido clínico, se necesita un índice de búsqueda aparte
              // (p. ej. tokens con hash determinista), no comparar contra el cifrado directo.
              {
                patient: {
                  OR: [
                    { firstName: { contains: query.q, mode: 'insensitive' } },
                    { lastName: { contains: query.q, mode: 'insensitive' } },
                  ],
                },
              },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.clinicalProcess.findMany({
        where,
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          ...CLINICAL_PROCESS_LIST_SELECT,
          sessions: { select: SESSION_SUMMARY_SELECT, orderBy: { startsAt: 'desc' }, take: 5 },
        },
      }),
      this.prisma.clinicalProcess.count({ where }),
    ]);

    // Lista blanca también sobre la respuesta: ni notas de sesión ni narrativa del proceso,
    // aunque una consulta futura trajera la fila completa. Nada que descifrar en un listado.
    const canRead = (row: { therapistId: string; patientId: string }) =>
      isClinician && (row.therapistId === actor.sub || treatingPatientIds.has(row.patientId));
    return { data: data.map((row) => {
      const projected = projectSelect<typeof row>(row, CLINICAL_PROCESS_LIST_PROJECTION);
      const readableRow = canRead(row);
      return { ...projected, title: readableRow ? projected.title : null, canReadClinical: readableRow };
    }), meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  async get(workspaceId: string, actor: AuthUser, id: string) {
    this.assertClinicalAccess(actor);
    const process = await this.prisma.clinicalProcess.findFirst({
      where: { id, workspaceId },
      include: {
        // Vista general del paciente: sin consultationReason (se sirve solo desde
        // GET /patients/:id/consultation-reason). El del proceso sí va: es su detalle clínico.
        patient: { select: PATIENT_VIEW_SELECT },
        therapist: { select: { id: true, firstName: true, lastName: true, email: true } },
        sessions: { where: { workspaceId }, orderBy: { startsAt: 'desc' } },
        _count: { select: { sessions: true } },
      },
    });
    if (!process) throw new NotFoundException('Proceso clínico no encontrado');

    // Autor (clínico) → todo lo suyo; clínico que trata al paciente → el proceso en solo lectura y
    // SIN notas internas ajenas; cualquier otro (OWNER/ADMIN que no trata...) → 403 auditado.
    const scope = await this.access.resolveScope(workspaceId, actor, process.patientId);
    const isAuthor = process.therapistId === actor.sub;
    if (!scope || (!isAuthor && scope.level !== 'TREATING')) {
      await this.access.auditDenied(workspaceId, actor, 'clinical-process', scope ? 'NOT_AUTHOR' : 'NO_PROCESS', process.patientId);
      throw new ForbiddenException('No tienes acceso al contenido clínico de este proceso');
    }

    const { internalNotes, ...rest } = decryptProcess({ ...process, patient: toPatientView(process.patient) });
    const sessions = (process.sessions ?? []).map((session) => {
      const decrypted = decryptSession(session);
      if (session.therapistId === actor.sub) return decrypted;
      // Resumen interno de otro profesional: nota interna, solo su autor.
      const { internalSummary: _hidden, ...visible } = decrypted;
      return visible;
    });
    return {
      ...rest,
      ...(isAuthor ? { internalNotes } : {}),
      sessions,
      readOnly: !(isAuthor && process.status === 'ACTIVE' && scope.level === 'TREATING'),
    };
  }

  async create(workspaceId: string, actor: AuthUser, dto: CreateClinicalProcessDto) {
    this.assertClinicalAccess(actor);
    const patient = await this.prisma.patient.findFirst({ where: { id: dto.patientId, workspaceId, status: { not: 'ARCHIVED' } } });
    if (!patient) throw new NotFoundException('Paciente no encontrado o archivado');

    const therapistId = this.resolveTherapistId(actor, dto.therapistId);
    await this.assertClinicianMember(workspaceId, therapistId);
    // Abrir un proceso a nombre de otro profesional es una operación administrativa: el contenido
    // clínico (motivo, objetivos, notas internas) solo lo escribe el propio profesional.
    const ownProcess = therapistId === actor.sub;
    if (!ownProcess && (dto.consultationReason !== undefined || dto.goals !== undefined || dto.internalNotes !== undefined)) {
      await this.access.auditDenied(workspaceId, actor, 'clinical-process-create', 'NOT_AUTHOR', dto.patientId);
      throw new ForbiddenException('El contenido clínico del proceso solo lo registra el profesional responsable');
    }

    return this.prisma.$transaction(async (tx) => {
      const process = await tx.clinicalProcess.create({
        data: {
          workspaceId,
          patientId: dto.patientId,
          therapistId,
          title: dto.title,
          consultationReason: encryptField(dto.consultationReason),
          goals: encryptField(dto.goals),
          internalNotes: encryptField(dto.internalNotes),
          modality: dto.modality,
          frequency: dto.frequency,
          startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined,
        },
      });
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_PROCESS_CREATED', entityType: 'ClinicalProcess', entityId: process.id, metadata: { patientId: dto.patientId, therapistId } },
      });
      return ownProcess ? decryptProcess(process) : toAdminView(process);
    });
  }

  async update(workspaceId: string, actor: AuthUser, id: string, dto: UpdateClinicalProcessDto) {
    this.assertClinicalAccess(actor);
    const process = await this.getRaw(workspaceId, id);
    const isAuthor = process.therapistId === actor.sub;
    const clinicalChange = CLINICAL_FIELDS.some((field) => dto[field] !== undefined);

    if (clinicalChange) {
      // Contenido clínico: solo el autor, clínico, que trata al paciente, con ESTE proceso activo.
      if (!isAuthor) {
        await this.access.auditDenied(workspaceId, actor, 'clinical-process-write', 'NOT_AUTHOR', process.patientId);
        throw new ForbiddenException('No puedes modificar el contenido clínico del proceso de otro profesional');
      }
      await this.access.assertTreating(workspaceId, actor, process.patientId, 'clinical-process-write');
      if (process.status === 'PAUSED' || process.status === 'DISCHARGED') {
        throw new ForbiddenException('Solo lectura: reactiva el proceso para modificar su contenido clínico');
      }
    } else {
      await this.assertCanManage(workspaceId, actor, process.therapistId);
    }

    if (process.status === 'CLOSED') throw new BadRequestException('No se puede editar un proceso cerrado');
    if (dto.patientId && dto.patientId !== process.patientId) throw new BadRequestException('No se puede cambiar el paciente de un proceso existente');

    const data: Prisma.ClinicalProcessUncheckedUpdateManyInput = {
      title: dto.title,
      consultationReason: dto.consultationReason !== undefined ? encryptField(dto.consultationReason) : undefined,
      goals: dto.goals !== undefined ? encryptField(dto.goals) : undefined,
      internalNotes: dto.internalNotes !== undefined ? encryptField(dto.internalNotes) : undefined,
      modality: dto.modality,
      frequency: dto.frequency,
      startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined,
    };

    if (dto.therapistId && dto.therapistId !== process.therapistId) {
      // Reasignar el proceso a otro profesional es una decisión de gestión, no del día a día clínico.
      if (!ADMIN_ROLES.includes(actor.role)) throw new ForbiddenException('Solo OWNER/ADMIN pueden reasignar un proceso clínico');
      await this.assertClinicianMember(workspaceId, dto.therapistId);
      data.therapistId = dto.therapistId;
    }

    // updateMany + comprobación de count, en vez de update({where:{id}}): así el filtro por
    // workspaceId se aplica también en la escritura, no solo en la comprobación previa.
    const { count } = await this.prisma.clinicalProcess.updateMany({ where: { id, workspaceId }, data });
    if (count === 0) throw new NotFoundException('Proceso clínico no encontrado');

    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_PROCESS_UPDATED', entityType: 'ClinicalProcess', entityId: id, metadata: { updatedFields: Object.keys(dto) } } });
    const saved = await this.getRaw(workspaceId, id);
    return isAuthor && saved.therapistId === actor.sub ? decryptProcess(saved) : toAdminView(saved);
  }

  async changeStatus(workspaceId: string, actor: AuthUser, id: string, status: ClinicalProcessStatusValue) {
    this.assertClinicalAccess(actor);
    const process = await this.getRaw(workspaceId, id);
    // Estado del proceso: operación de gestión (OWNER/ADMIN) o del propio profesional clínico.
    await this.assertCanManage(workspaceId, actor, process.therapistId);
    const view = (row: typeof process) => (row.therapistId === actor.sub ? decryptProcess(row) : toAdminView(row));

    if (process.status === status) return view(process);

    const allowed = ALLOWED_TRANSITIONS[process.status] ?? [];
    if (!allowed.includes(status)) {
      throw new BadRequestException(`No se puede pasar de ${process.status} a ${status}`);
    }

    const endedAt = status === 'DISCHARGED' || status === 'CLOSED' ? new Date() : null;
    const { count } = await this.prisma.clinicalProcess.updateMany({ where: { id, workspaceId }, data: { status, endedAt } });
    if (count === 0) throw new NotFoundException('Proceso clínico no encontrado');

    await this.prisma.auditLog.create({
      data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_PROCESS_STATUS_CHANGED', entityType: 'ClinicalProcess', entityId: id, metadata: { from: process.status, to: status } },
    });
    return view(await this.getRaw(workspaceId, id));
  }

  private assertClinicalAccess(actor: AuthUser) {
    if (!CLINICAL_ACCESS_ROLES.includes(actor.role)) {
      throw new ForbiddenException('Tu rol no tiene acceso a procesos clínicos');
    }
  }

  /**
   * Gestión administrativa del proceso (estado, modalidad, frecuencia, reasignación): OWNER/ADMIN
   * de cualquiera; el propio profesional solo del suyo y solo si sigue siendo clínico.
   */
  private async assertCanManage(workspaceId: string, actor: AuthUser, therapistId: string) {
    if (ADMIN_ROLES.includes(actor.role)) return;
    if (actor.sub === therapistId && (await this.access.isClinician(workspaceId, actor))) return;
    throw new ForbiddenException('No puedes gestionar el proceso clínico de otro profesional');
  }

  /** El profesional responsable de un proceso debe ser miembro clínico del workspace. */
  private async assertClinicianMember(workspaceId: string, userId: string) {
    const membership = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { role: true, isClinician: true } });
    if (!membership) throw new BadRequestException('El terapeuta no pertenece al espacio de trabajo');
    if (membership.role === 'ASSISTANT' || membership.isClinician !== true) {
      throw new BadRequestException('El profesional indicado no está marcado como profesional clínico');
    }
  }

  /**
   * Como get(), pero sin el include pesado: para uso interno cuando el caller ya validó el rol.
   * Devuelve los campos todavía cifrados a propósito — quien llame a getRaw() para volver a
   * escribir (update/changeStatus) no debe descifrar y recifrar sin necesidad; solo se
   * descifra en el punto final antes de devolver la respuesta al cliente.
   */
  private async getRaw(workspaceId: string, id: string) {
    const process = await this.prisma.clinicalProcess.findFirst({ where: { id, workspaceId } });
    if (!process) throw new NotFoundException('Proceso clínico no encontrado');
    return process;
  }

  private resolveTherapistId(actor: AuthUser, requested?: string): string {
    if (actor.role === 'THERAPIST') {
      if (requested && requested !== actor.sub) {
        throw new ForbiddenException('Un terapeuta solo puede abrir procesos clínicos a su propio nombre');
      }
      return actor.sub;
    }
    if (!requested) throw new BadRequestException('therapistId es obligatorio para abrir un proceso en nombre de un profesional');
    return requested;
  }
}

/** Vista administrativa de un proceso (respuestas a quien no es su autor): sin contenido clínico. */
function toAdminView<T extends Record<string, any>>(process: T) {
  return projectSelect<Record<string, unknown>>(process, CLINICAL_PROCESS_ADMIN_SELECT);
}
