/**
 * Borrado de los pacientes INVENTADOS (Patient.isDemo = true) y de todo lo que cuelga de ellos,
 * siempre acotado al workspace. Lo comparten:
 *  - el endpoint «Borrar los datos de ejemplo» del espacio de prueba (E1, solo OWNER), y
 *  - el script del operador db:purge-demo-workspace (que además retira las cuentas demo).
 * Nunca toca pacientes sin la marca isDemo ni nada fuera del workspace indicado.
 */
import { createHash } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

/** Negativa razonada (sin datos ni secretos en el mensaje). La API la traduce a 409. */
export class DemoRefusal extends Error {}

type Db = PrismaClient | Prisma.TransactionClient;

export interface SamplePatientsScope {
  patientIds: string[];
  sessions: number;
  processes: number;
  /** Facturas de pacientes inventados que ya no son borrador: borrarlas rompería la numeración. */
  nonDraftInvoices: number;
  /** Claves de objetos del almacenamiento (documentos y adjuntos de mensajes) de pacientes inventados. */
  storageKeys: string[];
}

export async function samplePatientsScope(db: Db, workspaceId: string): Promise<SamplePatientsScope> {
  const patients = await db.patient.findMany({ where: { workspaceId, isDemo: true }, select: { id: true } });
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
  return { patientIds, sessions, processes, nonDraftInvoices, storageKeys };
}

/** Correlatividad de facturas: nunca se borra una factura emitida, pagada o anulada. */
export function assertPurgeable(scope: Pick<SamplePatientsScope, 'nonDraftInvoices'>) {
  if (scope.nonDraftInvoices > 0) {
    throw new DemoRefusal(`Hay ${scope.nonDraftInvoices} facturas de pacientes de ejemplo que no son borrador: borrarlas dejaría huecos en la numeración. No se borra nada.`);
  }
}

/** Huella de una clave de almacenamiento para la auditoría (la clave puede llevar un nombre de archivo). */
export function storageKeyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Solicitudes de derechos (DataRightsRequest, rama feat/exportacion-y-derechos) tienen patientId
 * RESTRICT. Si la tabla existe, se borran primero las de pacientes inventados, acotadas al
 * workspace. Con SQL y to_regclass para que funcione igual antes y después de fusionar esa rama.
 */
async function deleteDemoDataRightsRequests(tx: Prisma.TransactionClient, workspaceId: string, patientIds: string[]): Promise<number> {
  if (!patientIds.length) return 0;
  const [{ exists }] = await tx.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass('"DataRightsRequest"') IS NOT NULL AS "exists"`;
  if (!exists) return 0;
  return tx.$executeRaw`DELETE FROM "DataRightsRequest" WHERE "workspaceId" = ${workspaceId} AND "patientId" = ANY(${patientIds}::text[])`;
}

/**
 * Borra los pacientes del scope (ya comprobado con assertPurgeable) y lo que cuelga de ellos. Sin
 * auditoría: la escribe quien llama, en la misma transacción.
 */
export async function deleteSamplePatients(tx: Prisma.TransactionClient, workspaceId: string, scope: SamplePatientsScope) {
  const inPatients = { workspaceId, patientId: { in: scope.patientIds } };
  // Hijos con FK RESTRICT hacia Patient, siempre acotados al workspace y a pacientes inventados.
  const dataRightsRequests = await deleteDemoDataRightsRequests(tx, workspaceId, scope.patientIds);
  const appointmentRequests = await tx.appointmentRequest.deleteMany({ where: inPatients });
  const payments = await tx.payment.deleteMany({ where: inPatients });
  const invoices = await tx.invoice.deleteMany({ where: { ...inPatients, status: 'DRAFT' } });
  const sessions = await tx.session.deleteMany({ where: inPatients });
  // Notas archivadas de procesos de ejemplo (FK RESTRICT hacia el proceso), acotadas igual.
  await tx.clinicalProcessPrivateNote.deleteMany({ where: { workspaceId, process: { is: inPatients } } });
  const processes = await tx.clinicalProcess.deleteMany({ where: inPatients });
  const notifications = await tx.notification.deleteMany({ where: inPatients });
  await tx.notificationPreference.deleteMany({ where: inPatients });
  // El resto (historia, objetivos, tareas, escalas, documentos, consentimientos, informes, portal,
  // recursos compartidos, conversaciones y mensajes) cae en cascada con el paciente.
  const patients = await tx.patient.deleteMany({ where: { workspaceId, isDemo: true, id: { in: scope.patientIds } } });
  return {
    patients: patients.count, sessions: sessions.count, processes: processes.count, draftInvoices: invoices.count,
    payments: payments.count, notifications: notifications.count, dataRightsRequests, appointmentRequests: appointmentRequests.count,
    // Sin claves completas (pueden llevar nombres de archivo): recuento y huellas para localizarlas.
    storageObjects: scope.storageKeys.length, storageKeyFingerprints: scope.storageKeys.map(storageKeyFingerprint),
  };
}
