import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';
import { isPatientPortalOpen, PORTAL_CLOSED_PATIENT_STATUSES } from '../portal/portal-access-mode.util';
import { randomPassword } from './demo-writer';
import { assertPurgeable, deleteSamplePatients, DemoRefusal, samplePatientsScope } from './sample-data-purge';

export const SAMPLE_DATA_NOT_PURGEABLE = 'SAMPLE_DATA_NOT_PURGEABLE';
export const SAMPLE_PORTAL_PATIENT_NOT_FOUND = 'SAMPLE_PORTAL_PATIENT_NOT_FOUND';

type Meta = { ip?: string; userAgent?: string };
type Db = PrismaService | Prisma.TransactionClient;

// Mismas formas que packages/contracts/src/sample-data.ts (la API no depende del paquete).
export interface SampleDataStatusContract {
  loaded: boolean; loadedAt: string | null; clearedAt: string | null; samplePatients: number;
  portalPatient: { patientId: string; firstName: string; lastName: string } | null;
}
export interface SamplePortalAccessContract { patientId: string; firstName: string; lastName: string; email: string; temporaryPassword: string; mustChangePassword: true }
export interface ClearSampleDataResultContract { clearedAt: string; deleted: { patients: number; sessions: number; processes: number } }

/**
 * E1 · Datos de ejemplo del espacio de prueba. SOLO el OWNER del espacio (rol leído de la BD, no del
 * token). Todo filtra por workspaceId y solo toca pacientes con isDemo=true. Nunca devuelve
 * contenido clínico: solo nombres inventados, recuentos e ids.
 */
@Injectable()
export class SampleDataService {
  constructor(private readonly prisma: PrismaService) {}

  async status(workspaceId: string, actor: AuthUser): Promise<SampleDataStatusContract> {
    await this.assertOwner(this.prisma, workspaceId, actor);
    const [workspace, samplePatients, portal] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { sampleDataLoadedAt: true, sampleDataClearedAt: true } }),
      this.prisma.patient.count({ where: { workspaceId, isDemo: true, deletedAt: null } }),
      this.findSamplePortalPatient(this.prisma, workspaceId),
    ]);
    return {
      loaded: Boolean(workspace?.sampleDataLoadedAt),
      loadedAt: workspace?.sampleDataLoadedAt?.toISOString() ?? null,
      clearedAt: workspace?.sampleDataClearedAt?.toISOString() ?? null,
      samplePatients,
      portalPatient: portal ? { patientId: portal.id, firstName: portal.firstName, lastName: portal.lastName } : null,
    };
  }

  /**
   * Contraseña temporal NUEVA del paciente de prueba, devuelta una sola vez. No se guarda en claro:
   * solo su hash. La auditoría registra quién la pidió y para qué cuenta, nunca correo ni contraseña.
   */
  async issuePortalAccess(workspaceId: string, actor: AuthUser, meta: Meta): Promise<SamplePortalAccessContract> {
    await this.assertOwner(this.prisma, workspaceId, actor);
    const patient = await this.findSamplePortalPatient(this.prisma, workspaceId);
    const account = patient?.portalAccounts[0];
    if (!patient || !account) {
      throw new NotFoundException({ statusCode: 404, code: SAMPLE_PORTAL_PATIENT_NOT_FOUND, message: 'Este espacio ya no tiene paciente de prueba con acceso al portal.' });
    }
    const temporaryPassword = randomPassword();
    const passwordHash = await hash(temporaryPassword, 12);

    await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, workspaceId, actor);
      const { count } = await tx.patientPortalAccount.updateMany({
        where: {
          id: account.id, workspaceId, patientId: patient.id, accessorType: 'PATIENT',
          patient: { workspaceId, isDemo: true, deletedAt: null, status: { notIn: [...PORTAL_CLOSED_PATIENT_STATUSES] } },
        },
        data: { passwordHash, mustChangePassword: true, isActive: true, pendingActivation: false, failedLoginAttempts: 0, lockedUntil: null },
      });
      if (count !== 1) throw new ConflictException('El paciente de prueba ha cambiado; recarga y vuelve a intentarlo.');
      await tx.auditLog.create({
        data: {
          workspaceId, actorId: actor.sub, action: 'SAMPLE_PORTAL_ACCESS_ISSUED', entityType: 'PatientPortalAccount', entityId: account.id,
          metadata: { patientId: patient.id, dataset: 'E1' }, ipAddress: meta.ip, userAgent: meta.userAgent,
        },
      });
    });

    return { patientId: patient.id, firstName: patient.firstName, lastName: patient.lastName, email: account.email, temporaryPassword, mustChangePassword: true };
  }

  /** Borra SOLO los pacientes de ejemplo (isDemo) del espacio y lo que cuelga de ellos. Auditado. */
  async clear(workspaceId: string, actor: AuthUser, meta: Meta): Promise<ClearSampleDataResultContract> {
    const clearedAt = new Date();
    const counts = await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, workspaceId, actor);
      const scope = await samplePatientsScope(tx, workspaceId);
      try {
        assertPurgeable(scope);
      } catch (error) {
        if (error instanceof DemoRefusal) throw new ConflictException({ statusCode: 409, code: SAMPLE_DATA_NOT_PURGEABLE, message: error.message });
        throw error;
      }
      const deleted = await deleteSamplePatients(tx, workspaceId, scope);
      await tx.workspace.updateMany({ where: { id: workspaceId }, data: { sampleDataClearedAt: clearedAt } });
      await tx.auditLog.create({
        data: {
          workspaceId, actorId: actor.sub, action: 'SAMPLE_DATA_CLEARED', entityType: 'Workspace', entityId: workspaceId,
          metadata: { dataset: 'E1', ...deleted }, ipAddress: meta.ip, userAgent: meta.userAgent,
        },
      });
      return deleted;
    }, { maxWait: 10_000, timeout: 60_000 });
    return { clearedAt: clearedAt.toISOString(), deleted: { patients: counts.patients, sessions: counts.sessions, processes: counts.processes } };
  }

  /** OWNER activo del espacio según la BD. Cualquier otro rol (o un token que no es de staff): 403. */
  private async assertOwner(db: Db, workspaceId: string, actor: AuthUser) {
    assertStaffRole(actor);
    const member = await db.workspaceMember.findFirst({ where: { workspaceId, userId: actor.sub, status: 'ACTIVE' }, select: { role: true } });
    if (member?.role !== 'OWNER') throw new ForbiddenException('Solo el titular del espacio gestiona los datos de ejemplo');
  }

  /** Paciente de ejemplo (isDemo) con cuenta de portal propia (PATIENT), del espacio y con el portal abierto. */
  private async findSamplePortalPatient(db: Db, workspaceId: string) {
    const patient = await db.patient.findFirst({
      where: { workspaceId, isDemo: true, deletedAt: null, portalAccounts: { some: { workspaceId, accessorType: 'PATIENT' } } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, firstName: true, lastName: true, status: true,
        portalAccounts: { where: { workspaceId, accessorType: 'PATIENT' }, orderBy: { createdAt: 'asc' }, take: 1, select: { id: true, email: true } },
      },
    });
    return patient && isPatientPortalOpen(patient.status) ? patient : null;
  }
}
