import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';

/**
 * Punto ÚNICO de decisión del acceso al contenido clínico de un paciente.
 *
 * Regla (falla en cerrado):
 *  - Solo un miembro con `isClinician` (y rol distinto de ASSISTANT, según la BD, no el token)
 *    puede ver contenido clínico.
 *  - TREATING: tiene al menos un proceso ACTIVO con el paciente → ve el contenido clínico del
 *    paciente (lectura y escritura), salvo las notas internas de otros autores.
 *  - FORMER_AUTHOR: no tiene proceso activo pero es autor de algún proceso del paciente → solo
 *    LECTURA de lo suyo (sus procesos, sus sesiones, sus informes y documentos...). Nada de lo
 *    que no se pueda atribuir a un autor (historia, objetivos, escalas, motivo de consulta).
 *  - Cualquier otro caso (OWNER/ADMIN que no trata, ASSISTANT, clínico sin proceso, miembro
 *    no encontrado, error de datos) → sin acceso. Los intentos denegados se auditan.
 *
 * Ser OWNER o ADMIN no da acceso clínico: solo operaciones administrativas.
 */

export type ClinicalAccessLevel = 'TREATING' | 'FORMER_AUTHOR';

/** Ventana temporal de un proceso propio (para acotar la mensajería a "lo suyo"). */
export interface ProcessWindow { from: Date; to: Date | null }

export interface ClinicalScope {
  level: ClinicalAccessLevel;
  actorId: string;
  /** Procesos del actor con este paciente (cualquier estado). */
  ownProcessIds: string[];
  /** Procesos ACTIVOS del actor con este paciente. */
  activeProcessIds: string[];
  /**
   * Ventanas [alta del proceso, fin] de los procesos propios. Se usa `createdAt` (no `startedAt`,
   * que el usuario puede fijar hacia atrás) para no abrir mensajes anteriores a su tratamiento.
   */
  processWindows: ProcessWindow[];
}

export interface MemberClinicalProfile { role: string; isClinician: boolean }

export type DenialReason = 'ROLE' | 'NOT_MEMBER' | 'NOT_CLINICIAN' | 'NO_PROCESS' | 'READ_ONLY' | 'NOT_AUTHOR';

type PatientRow = NonNullable<Awaited<ReturnType<PrismaService['patient']['findFirst']>>>;

const NON_CLINICAL_ROLES = new Set(['ASSISTANT']);

@Injectable()
export class ClinicalAccessService {
  private readonly logger = new Logger(ClinicalAccessService.name);

  constructor(protected readonly prisma: PrismaService) {}

  /** Perfil clínico del miembro según la BD (no según el token). null si no es miembro. */
  async getMemberProfile(workspaceId: string, actor: AuthUser): Promise<MemberClinicalProfile | null> {
    if (!actor?.sub || !workspaceId) return null;
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId: actor.sub },
      select: { role: true, isClinician: true },
    });
    return member ? { role: member.role, isClinician: member.isClinician === true } : null;
  }

  /** ¿Es profesional clínico en este workspace? (rol no ASSISTANT en token y BD, e isClinician). */
  async isClinician(workspaceId: string, actor: AuthUser): Promise<boolean> {
    if (!actor || NON_CLINICAL_ROLES.has(actor.role)) return false;
    const profile = await this.getMemberProfile(workspaceId, actor);
    return Boolean(profile && profile.isClinician && !NON_CLINICAL_ROLES.has(profile.role));
  }

  /** Exige ser profesional clínico (sin mirar pacientes): biblioteca de tareas, etc. */
  async assertClinician(workspaceId: string, actor: AuthUser, resource: string) {
    assertStaffRole(actor);
    if (!(await this.isClinician(workspaceId, actor))) {
      await this.auditDenied(workspaceId, actor, resource, NON_CLINICAL_ROLES.has(actor.role) ? 'ROLE' : 'NOT_CLINICIAN');
      throw new ForbiddenException('No tienes acceso al contenido clínico');
    }
  }

  /**
   * Nivel de acceso del actor al paciente, o null si no tiene ninguno. No lanza por falta de
   * acceso (para vistas que degradan a datos administrativos); el paciente debe existir antes.
   */
  async resolveScope(workspaceId: string, actor: AuthUser, patientId: string): Promise<ClinicalScope | null> {
    const decision = await this.decide(workspaceId, actor, patientId);
    return decision.scope;
  }

  /**
   * Ids de pacientes que el actor está TRATANDO (proceso ACTIVO propio) si es clínico. Para
   * listados que deciden fila a fila (procesos, bandeja de mensajes, avisos del panel).
   */
  async treatingPatientIds(workspaceId: string, actor: AuthUser): Promise<Set<string>> {
    return (await this.listingContext(workspaceId, actor)).treatingPatientIds;
  }

  /** Contexto para listados: si es clínico y a qué pacientes trata ahora. */
  async listingContext(workspaceId: string, actor: AuthUser): Promise<{ isClinician: boolean; treatingPatientIds: Set<string> }> {
    if (!(await this.isClinician(workspaceId, actor))) return { isClinician: false, treatingPatientIds: new Set() };
    const rows = await this.prisma.clinicalProcess.findMany({
      where: { workspaceId, therapistId: actor.sub, status: 'ACTIVE' },
      select: { patientId: true },
    });
    return { isClinician: true, treatingPatientIds: new Set(rows.map((row) => row.patientId)) };
  }

  /**
   * Exige acceso de TRATAMIENTO (proceso ACTIVO propio con el paciente). Es la comprobación por
   * defecto de todo endpoint clínico: lecturas no atribuibles a un autor y todas las escrituras.
   * Devuelve la fila del paciente (acotada al workspace).
   */
  async assertPatientClinicalAccess(workspaceId: string, actor: AuthUser, patientId: string, resource = 'patient-clinical'): Promise<PatientRow> {
    const { patient } = await this.assertTreating(workspaceId, actor, patientId, resource);
    return patient;
  }

  async assertTreating(workspaceId: string, actor: AuthUser, patientId: string, resource: string) {
    const { patient, scope, reason } = await this.decide(workspaceId, actor, patientId, true);
    if (!scope || scope.level !== 'TREATING') {
      await this.auditDenied(workspaceId, actor, resource, scope ? 'READ_ONLY' : reason!, patientId);
      throw new ForbiddenException(scope
        ? 'Solo lectura: tu proceso con este paciente no está activo'
        : 'No tienes acceso al contenido clínico de este paciente');
    }
    return { patient: patient!, scope };
  }

  /**
   * Exige acceso de LECTURA: TREATING, o FORMER_AUTHOR (el llamador DEBE filtrar entonces por
   * autor con `scope`). Solo para endpoints que saben acotar a lo propio.
   */
  async assertCanRead(workspaceId: string, actor: AuthUser, patientId: string, resource: string) {
    const { patient, scope, reason } = await this.decide(workspaceId, actor, patientId, true);
    if (!scope) {
      await this.auditDenied(workspaceId, actor, resource, reason!, patientId);
      throw new ForbiddenException('No tienes acceso al contenido clínico de este paciente');
    }
    return { patient: patient!, scope };
  }

  /** Registra un intento denegado. Nunca bloquea la denegación si la auditoría falla. */
  async auditDenied(workspaceId: string, actor: AuthUser, resource: string, reason: DenialReason, patientId?: string) {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId,
          actorId: actor?.sub ?? null,
          action: 'CLINICAL_ACCESS_DENIED',
          entityType: 'Patient',
          entityId: patientId ?? null,
          // Solo ids y códigos: nunca contenido.
          metadata: { resource, reason, role: actor?.role ?? null } as Prisma.InputJsonValue,
        },
      });
    } catch {
      this.logger.warn(`No se pudo auditar un acceso clínico denegado (${resource}, ${reason})`);
    }
  }

  // ---------------------------------------------------------------------------------------

  private async decide(workspaceId: string, actor: AuthUser, patientId: string, requirePatient = false): Promise<{ patient: PatientRow | null; scope: ClinicalScope | null; reason?: DenialReason }> {
    assertStaffRole(actor);
    // Rol no clínico en el token: se deniega sin tocar el paciente (ni confirmar su existencia).
    if (NON_CLINICAL_ROLES.has(actor.role)) return { patient: null, scope: null, reason: 'ROLE' };

    let patient: PatientRow | null = null;
    if (requirePatient) {
      patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId } });
      if (!patient) throw new NotFoundException('Paciente no encontrado');
    }

    const profile = await this.getMemberProfile(workspaceId, actor);
    if (!profile) return { patient, scope: null, reason: 'NOT_MEMBER' };
    if (NON_CLINICAL_ROLES.has(profile.role)) return { patient, scope: null, reason: 'ROLE' };
    if (!profile.isClinician) return { patient, scope: null, reason: 'NOT_CLINICIAN' };

    const processes = await this.prisma.clinicalProcess.findMany({
      where: { workspaceId, patientId, therapistId: actor.sub },
      select: { id: true, status: true, createdAt: true, endedAt: true, updatedAt: true },
    });
    if (!processes.length) return { patient, scope: null, reason: 'NO_PROCESS' };

    const active = processes.filter((process) => process.status === 'ACTIVE');
    const scope: ClinicalScope = {
      level: active.length ? 'TREATING' : 'FORMER_AUTHOR',
      actorId: actor.sub,
      ownProcessIds: processes.map((process) => process.id),
      activeProcessIds: active.map((process) => process.id),
      processWindows: processes.map((process) => ({
        from: new Date(process.createdAt),
        // Proceso activo: ventana abierta. No activo: hasta su fin (o su última modificación
        // si está en pausa y no tiene fecha de fin).
        to: process.status === 'ACTIVE' ? null : new Date(process.endedAt ?? process.updatedAt),
      })),
    };
    return { patient, scope };
  }
}

/** Filtro Prisma de mensajes dentro de las ventanas de los procesos propios. */
export function messageWindowFilter(scope: ClinicalScope): Prisma.MessageWhereInput {
  if (!scope.processWindows.length) return { id: { in: [] } };
  return {
    OR: scope.processWindows.map((window) => ({
      createdAt: { gte: window.from, ...(window.to ? { lte: window.to } : {}) },
    })),
  };
}
