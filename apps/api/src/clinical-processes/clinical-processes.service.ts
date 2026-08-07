import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClinicalProcessStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { CreateClinicalProcessDto } from './dto/create-clinical-process.dto';
import { UpdateClinicalProcessDto } from './dto/update-clinical-process.dto';
import { ClinicalProcessStatusValue } from './dto/change-clinical-process-status.dto';
import { ListClinicalProcessesQueryDto } from './dto/list-clinical-processes-query.dto';

// Solo quien puede dar o supervisar terapia entra aquí. ASSISTANT gestiona agenda y altas de
// pacientes, pero nunca motivo de consulta, objetivos ni notas internas: eso es contenido clínico.
const CLINICAL_ACCESS_ROLES = ['OWNER', 'ADMIN', 'THERAPIST'];

// CLOSED es terminal a propósito: si un proceso se cierra por error no se "deshace" reabriéndolo,
// se documenta y se abre uno nuevo. DISCHARGED sí puede reabrirse (el paciente vuelve a consulta).
const ALLOWED_TRANSITIONS: Record<ClinicalProcessStatus, ClinicalProcessStatusValue[]> = {
  ACTIVE: ['PAUSED', 'DISCHARGED', 'CLOSED'],
  PAUSED: ['ACTIVE', 'DISCHARGED', 'CLOSED'],
  DISCHARGED: ['ACTIVE'],
  CLOSED: [],
};

@Injectable()
export class ClinicalProcessesService {
  constructor(private prisma: PrismaService) {}

  async list(workspaceId: string, actor: AuthUser, query: ListClinicalProcessesQueryDto) {
    this.assertClinicalAccess(actor);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    // Un THERAPIST solo puede listar los suyos, sea cual sea el therapistId que pida por query.
    const therapistId = actor.role === 'THERAPIST' ? actor.sub : query.therapistId;

    const where: Prisma.ClinicalProcessWhereInput = {
      workspaceId,
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(therapistId ? { therapistId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { consultationReason: { contains: query.q, mode: 'insensitive' } },
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
        include: {
          patient: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
          therapist: { select: { id: true, firstName: true, lastName: true } },
          sessions: { orderBy: { startsAt: 'desc' }, take: 5 },
          _count: { select: { sessions: true } },
        },
      }),
      this.prisma.clinicalProcess.count({ where }),
    ]);

    return { data, meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  async get(workspaceId: string, actor: AuthUser, id: string) {
    this.assertClinicalAccess(actor);
    const process = await this.prisma.clinicalProcess.findFirst({
      where: { id, workspaceId },
      include: {
        patient: true,
        therapist: { select: { id: true, firstName: true, lastName: true, email: true } },
        sessions: { orderBy: { startsAt: 'desc' } },
        _count: { select: { sessions: true } },
      },
    });
    if (!process) throw new NotFoundException('Proceso clínico no encontrado');
    this.assertCanManage(actor, process.therapistId);
    return process;
  }

  async create(workspaceId: string, actor: AuthUser, dto: CreateClinicalProcessDto) {
    this.assertClinicalAccess(actor);
    const patient = await this.prisma.patient.findFirst({ where: { id: dto.patientId, workspaceId, status: { not: 'ARCHIVED' } } });
    if (!patient) throw new NotFoundException('Paciente no encontrado o archivado');

    const therapistId = this.resolveTherapistId(actor, dto.therapistId);
    const membership = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId: therapistId } });
    if (!membership) throw new BadRequestException('El terapeuta no pertenece al espacio de trabajo');

    return this.prisma.$transaction(async (tx) => {
      const process = await tx.clinicalProcess.create({
        data: {
          workspaceId,
          patientId: dto.patientId,
          therapistId,
          title: dto.title,
          consultationReason: dto.consultationReason,
          goals: dto.goals,
          internalNotes: dto.internalNotes,
          modality: dto.modality,
          frequency: dto.frequency,
          startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined,
        },
      });
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_PROCESS_CREATED', entityType: 'ClinicalProcess', entityId: process.id, metadata: { patientId: dto.patientId } },
      });
      return process;
    });
  }

  async update(workspaceId: string, actor: AuthUser, id: string, dto: UpdateClinicalProcessDto) {
    this.assertClinicalAccess(actor);
    const process = await this.getRaw(workspaceId, id);
    this.assertCanManage(actor, process.therapistId);

    if (process.status === 'CLOSED') throw new BadRequestException('No se puede editar un proceso cerrado');
    if (dto.patientId && dto.patientId !== process.patientId) throw new BadRequestException('No se puede cambiar el paciente de un proceso existente');

    const data: Prisma.ClinicalProcessUncheckedUpdateManyInput = {
      title: dto.title,
      consultationReason: dto.consultationReason,
      goals: dto.goals,
      internalNotes: dto.internalNotes,
      modality: dto.modality,
      frequency: dto.frequency,
      startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined,
    };

    if (dto.therapistId && dto.therapistId !== process.therapistId) {
      // Reasignar el proceso a otro profesional es una decisión de gestión, no del día a día clínico.
      if (actor.role === 'THERAPIST') throw new ForbiddenException('Solo OWNER/ADMIN pueden reasignar un proceso clínico');
      const membership = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId: dto.therapistId } });
      if (!membership) throw new BadRequestException('El terapeuta no pertenece al espacio de trabajo');
      data.therapistId = dto.therapistId;
    }

    // updateMany + comprobación de count, en vez de update({where:{id}}): así el filtro por
    // workspaceId se aplica también en la escritura, no solo en la comprobación previa.
    const { count } = await this.prisma.clinicalProcess.updateMany({ where: { id, workspaceId }, data });
    if (count === 0) throw new NotFoundException('Proceso clínico no encontrado');

    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_PROCESS_UPDATED', entityType: 'ClinicalProcess', entityId: id } });
    return this.getRaw(workspaceId, id);
  }

  async changeStatus(workspaceId: string, actor: AuthUser, id: string, status: ClinicalProcessStatusValue) {
    this.assertClinicalAccess(actor);
    const process = await this.getRaw(workspaceId, id);
    this.assertCanManage(actor, process.therapistId);

    if (process.status === status) return process;

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
    return this.getRaw(workspaceId, id);
  }

  private assertClinicalAccess(actor: AuthUser) {
    if (!CLINICAL_ACCESS_ROLES.includes(actor.role)) {
      throw new ForbiddenException('Tu rol no tiene acceso a procesos clínicos');
    }
  }

  /** Un THERAPIST solo gestiona sus propios procesos; OWNER/ADMIN pueden ver y gestionar cualquiera. */
  private assertCanManage(actor: AuthUser, therapistId: string) {
    if (actor.role === 'THERAPIST' && actor.sub !== therapistId) {
      throw new ForbiddenException('No puedes acceder al proceso clínico de otro profesional');
    }
  }

  /** Como get(), pero sin el include pesado: para uso interno cuando el caller ya validó el rol. */
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
