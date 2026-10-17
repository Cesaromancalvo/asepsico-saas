/**
 * Núcleo de db:purge-demo-workspace: qué se borra y en qué orden. Solo pacientes con isDemo=true
 * (y lo que cuelga de ellos) y miembros cuyo usuario tiene isDemo=true, siempre acotado al workspace.
 */
import { createHash, randomBytes } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { DemoRefusal } from './demo-guards';

type Db = PrismaClient | Prisma.TransactionClient;

export interface DemoPurgeScope {
  patientIds: string[];
  members: { id: string; userId: string }[];
  sessions: number;
  processes: number;
  /** Facturas de pacientes demo que ya no son borrador: borrarlas rompería la numeración. */
  nonDraftInvoices: number;
  /** Claves de objetos en el almacenamiento (documentos y adjuntos de mensajes) de pacientes demo. */
  storageKeys: string[];
}

export async function demoPurgeScope(db: Db, workspaceId: string): Promise<DemoPurgeScope> {
  const patients = await db.patient.findMany({ where: { workspaceId, isDemo: true }, select: { id: true } });
  const members = await db.workspaceMember.findMany({ where: { workspaceId, user: { isDemo: true } }, select: { id: true, userId: true } });
  const patientIds = patients.map((p) => p.id);
  const inPatients = { workspaceId, patientId: { in: patientIds } };
  const [sessions, processes, nonDraftInvoices, documents, attachments] = await Promise.all([
    db.session.count({ where: inPatients }),
    db.clinicalProcess.count({ where: inPatients }),
    db.invoice.count({ where: { ...inPatients, status: { not: 'DRAFT' } } }),
    db.patientDocument.findMany({ where: { ...inPatients, storageKey: { not: null } }, select: { storageKey: true } }),
    db.message.findMany({ where: { attachmentKey: { not: null }, conversation: inPatients }, select: { attachmentKey: true } }),
  ]);
  const storageKeys = [...documents.map((d) => d.storageKey!), ...attachments.map((m) => m.attachmentKey!)];
  return { patientIds, members, sessions, processes, nonDraftInvoices, storageKeys };
}

/** Correlatividad de facturas: nunca se borra una factura emitida, pagada o anulada. */
export function assertPurgeable(scope: Pick<DemoPurgeScope, 'nonDraftInvoices'>) {
  if (scope.nonDraftInvoices > 0) {
    throw new DemoRefusal(`Hay ${scope.nonDraftInvoices} facturas de pacientes demo que no son borrador: borrarlas dejaría huecos en la numeración. No se borra nada; revisa el espacio a mano.`);
  }
}

/** Huella de una clave de almacenamiento para la auditoría (la clave puede llevar un nombre de archivo). */
export function storageKeyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
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

/**
 * Solicitudes de derechos (DataRightsRequest, rama feat/exportacion-y-derechos) tienen patientId
 * RESTRICT. Si la tabla existe, se borran primero las de pacientes demo, acotadas al workspace. Con
 * SQL y to_regclass para que funcione igual antes y después de fusionar esa rama, sin tocar nada.
 */
async function deleteDemoDataRightsRequests(tx: Prisma.TransactionClient, workspaceId: string, patientIds: string[]): Promise<number> {
  if (!patientIds.length) return 0;
  const [{ exists }] = await tx.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass('"DataRightsRequest"') IS NOT NULL AS "exists"`;
  if (!exists) return 0;
  return tx.$executeRaw`DELETE FROM "DataRightsRequest" WHERE "workspaceId" = ${workspaceId} AND "patientId" = ANY(${patientIds}::text[])`;
}

export async function purgeDemoData(tx: Prisma.TransactionClient, workspaceId: string) {
  const scope = await demoPurgeScope(tx, workspaceId);
  assertPurgeable(scope);
  const inPatients = { workspaceId, patientId: { in: scope.patientIds } };
  // Hijos con FK RESTRICT hacia Patient, siempre acotados al workspace y a pacientes demo.
  const dataRightsRequests = await deleteDemoDataRightsRequests(tx, workspaceId, scope.patientIds);
  const appointmentRequests = await tx.appointmentRequest.deleteMany({ where: inPatients });
  const payments = await tx.payment.deleteMany({ where: inPatients });
  const invoices = await tx.invoice.deleteMany({ where: { ...inPatients, status: 'DRAFT' } });
  const sessions = await tx.session.deleteMany({ where: inPatients });
  const processes = await tx.clinicalProcess.deleteMany({ where: inPatients });
  const notifications = await tx.notification.deleteMany({ where: inPatients });
  await tx.notificationPreference.deleteMany({ where: inPatients });
  // El resto (historia, objetivos, tareas, escalas, documentos, consentimientos, informes, portal,
  // recursos compartidos, conversaciones y mensajes) cae en cascada con el paciente.
  const patients = await tx.patient.deleteMany({ where: { workspaceId, isDemo: true, id: { in: scope.patientIds } } });

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

  const counts = {
    patients: patients.count, sessions: sessions.count, processes: processes.count, draftInvoices: invoices.count,
    payments: payments.count, notifications: notifications.count, dataRightsRequests, appointmentRequests: appointmentRequests.count,
    demoMembersRemoved: scope.members.length, usersDeleted, usersDisabled,
    // Sin claves completas (pueden llevar nombres de archivo): recuento y huellas para localizarlas.
    storageObjects: scope.storageKeys.length, storageKeyFingerprints: scope.storageKeys.map(storageKeyFingerprint),
  };
  await tx.auditLog.create({
    data: { workspaceId, actorId: null, action: 'DEMO_PURGE', entityType: 'Workspace', entityId: workspaceId, metadata: { source: 'db:purge-demo-workspace', ...counts } },
  });
  return { counts, storageKeys: scope.storageKeys };
}
