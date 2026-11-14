/**
 * Núcleo de db:purge-demo-workspace: qué se borra y en qué orden. Solo pacientes con isDemo=true
 * (y lo que cuelga de ellos) y miembros cuyo usuario tiene isDemo=true, siempre acotado al workspace.
 * La parte de pacientes es la misma que usa el endpoint de la API (src/sample-data/sample-data-purge).
 */
import { randomBytes } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  assertPurgeable, deleteSamplePatients, samplePatientsScope, SamplePatientsScope, storageKeyFingerprint,
} from '../../../src/sample-data/sample-data-purge';

export { assertPurgeable, storageKeyFingerprint };

type Db = PrismaClient | Prisma.TransactionClient;

export interface DemoPurgeScope extends SamplePatientsScope {
  members: { id: string; userId: string }[];
}

export async function demoPurgeScope(db: Db, workspaceId: string): Promise<DemoPurgeScope> {
  const patients = await samplePatientsScope(db, workspaceId);
  const members = await db.workspaceMember.findMany({ where: { workspaceId, user: { isDemo: true } }, select: { id: true, userId: true } });
  return { ...patients, members };
}

/** Registros que impiden borrar a un usuario demo (FK RESTRICT o evidencia que se conserva). */
async function userIsReferenced(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const counts = await Promise.all([
    tx.session.count({ where: { therapistId: userId } }),
    tx.clinicalProcess.count({ where: { therapistId: userId } }),
    tx.termsAcceptance.count({ where: { userId } }),
    tx.therapeuticResource.count({ where: { createdById: userId } }),
    tx.patientDocument.count({ where: { createdById: userId } }),
    tx.consentRecord.count({ where: { createdById: userId } }),
    tx.clinicalReport.count({ where: { createdById: userId } }),
    tx.invoice.count({ where: { createdById: userId } }),
    tx.payment.count({ where: { recordedById: userId } }),
    tx.workspaceMember.count({ where: { userId } }),
    tx.appointmentRequest.count({ where: { therapistId: userId } }),
    tx.therapistAvailability.count({ where: { therapistId: userId } }),
    tx.availabilityWindow.count({ where: { therapistId: userId } }),
    tx.availabilityBlock.count({ where: { therapistId: userId } }),
  ]);
  return counts.some((n) => n > 0);
}

export async function purgeDemoData(tx: Prisma.TransactionClient, workspaceId: string) {
  const scope = await demoPurgeScope(tx, workspaceId);
  assertPurgeable(scope);
  const patientCounts = await deleteSamplePatients(tx, workspaceId, scope);

  let usersDeleted = 0;
  let usersDisabled = 0;
  for (const member of scope.members) {
    await tx.workspaceMember.deleteMany({ where: { id: member.id, workspaceId } });
    // Disponibilidad del miembro demo en ESTE espacio (configuración de agenda, sin datos de pacientes).
    await tx.availabilityBlock.deleteMany({ where: { workspaceId, therapistId: member.userId } });
    await tx.availabilityWindow.deleteMany({ where: { workspaceId, therapistId: member.userId } });
    await tx.therapistAvailability.deleteMany({ where: { workspaceId, therapistId: member.userId } });
    // Avisos al profesional (userId, sin paciente): la solicitud de cita le avisa sin patientId y no caería con el paciente.
    await tx.notification.deleteMany({ where: { workspaceId, audience: 'PROFESSIONAL', userId: member.userId, type: 'APPOINTMENT_REQUEST' } });
    await tx.refreshToken.updateMany({ where: { userId: member.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (await userIsReferenced(tx, member.userId)) {
      // Hash inválido para bcrypt: ninguna contraseña coincide. Sin MFA ni sesiones vivas.
      await tx.user.updateMany({
        where: { id: member.userId, isDemo: true },
        data: { passwordHash: `!disabled-demo-${randomBytes(16).toString('hex')}`, totpEnabled: false, totpSecret: null, mfaRecoveryCodes: [] },
      });
      usersDisabled++;
    } else {
      usersDeleted += (await tx.user.deleteMany({ where: { id: member.userId, isDemo: true } })).count;
    }
  }

  const counts = { ...patientCounts, demoMembersRemoved: scope.members.length, usersDeleted, usersDisabled };
  await tx.auditLog.create({
    data: { workspaceId, actorId: null, action: 'DEMO_PURGE', entityType: 'Workspace', entityId: workspaceId, metadata: { source: 'db:purge-demo-workspace', ...counts } },
  });
  return { counts, storageKeys: scope.storageKeys };
}
