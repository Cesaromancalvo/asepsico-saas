import { Prisma } from '@prisma/client';

/**
 * Transiciones de solicitudes de cita que se disparan desde fuera del flujo normal (caducidad,
 * cierre del proceso, archivado o bloqueo del paciente, baja del portal). Siempre dentro de la
 * transacción del llamante, acotadas por workspaceId, con compare-and-set del estado PENDING y
 * con su auditoría en la misma transacción.
 *
 * Los avisos guardados son genéricos: nunca nombre del paciente, fecha ni hora (criterio 26).
 */

export const PROFESSIONAL_REQUEST_NOTICE = {
  title: 'Nueva solicitud de cita',
  body: 'Tienes una nueva solicitud de cita. Revísala en la agenda.',
  actionUrl: '/agenda/solicitudes',
} as const;

export const PATIENT_REQUEST_UPDATE_NOTICE = {
  title: 'Solicitud de cita respondida',
  body: 'Tu solicitud de cita ha sido respondida. Consúltala en tu portal.',
  actionUrl: '/portal',
} as const;

type Tx = Prisma.TransactionClient;
type PendingRow = { id: string; patientId: string; therapistId: string; type: string; startsAt: Date | null };

export async function notifyProfessionalOfRequest(tx: Tx, workspaceId: string, therapistId: string, requestId: string) {
  const now = new Date();
  await tx.notification.createMany({
    data: [{
      workspaceId, audience: 'PROFESSIONAL', userId: therapistId, type: 'APPOINTMENT_REQUEST',
      ...PROFESSIONAL_REQUEST_NOTICE, status: 'SENT', scheduledAt: now, sentAt: now,
      dedupeKey: `appointment-request:${requestId}:therapist`,
    }],
    skipDuplicates: true,
  });
}

export async function notifyPatientOfRequestUpdates(tx: Tx, workspaceId: string, rows: { id: string; patientId: string }[], status: string) {
  if (!rows.length) return;
  const now = new Date();
  await tx.notification.createMany({
    data: rows.map((row) => ({
      workspaceId, audience: 'PATIENT' as const, patientId: row.patientId, type: 'APPOINTMENT_REQUEST_UPDATE' as const,
      ...PATIENT_REQUEST_UPDATE_NOTICE, status: 'SENT' as const, scheduledAt: now, sentAt: now,
      dedupeKey: `appointment-request:${row.id}:patient:${status}`,
    })),
    skipDuplicates: true,
  });
}

/** Cierra las PENDING indicadas (compare-and-set fila a fila) y devuelve las que cambió esta llamada. */
async function closeRows(
  tx: Tx,
  workspaceId: string,
  rows: PendingRow[],
  data: Prisma.AppointmentRequestUpdateManyMutationInput,
): Promise<PendingRow[]> {
  const changed: PendingRow[] = [];
  // Orden estable por id: dos rutas sin advisory lock común no cruzan filas en distinto orden.
  for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const { count } = await tx.appointmentRequest.updateMany({
      where: { id: row.id, workspaceId, status: 'PENDING' },
      data: { ...data, heldStartsAt: null, resolvedAt: new Date() },
    });
    if (count === 1) changed.push(row);
  }
  return changed;
}

const PENDING_SELECT = { id: true, patientId: true, therapistId: true, type: true, startsAt: true } as const;

/**
 * Caducidad: PENDING cuyo plazo ("inicio − antelación mínima") ya pasó → EXPIRED, el hueco se
 * libera y el paciente recibe un aviso genérico. Se llama de forma perezosa antes de leer o de
 * escribir (no hace falta un cron para que el hueco quede libre: findScheduleConflict ya ignora
 * las caducadas).
 */
export async function expireDueRequests(tx: Tx, workspaceId: string, scope: { therapistId?: string; patientId?: string } = {}) {
  const now = new Date();
  const due = await tx.appointmentRequest.findMany({
    where: { workspaceId, status: 'PENDING', expiresAt: { lte: now }, ...scope },
    orderBy: { id: 'asc' },
    select: PENDING_SELECT,
    take: 200,
  });
  if (!due.length) return 0;
  const changed = await closeRows(tx, workspaceId, due, { status: 'EXPIRED' });
  if (changed.length) {
    await tx.auditLog.createMany({
      data: changed.map((row) => ({
        workspaceId, actorId: null, action: 'APPOINTMENT_REQUEST_EXPIRED', entityType: 'AppointmentRequest', entityId: row.id,
        metadata: { patientId: row.patientId, therapistId: row.therapistId, type: row.type, startsAt: row.startsAt?.toISOString() ?? null },
      })),
    });
    await notifyPatientOfRequestUpdates(tx, workspaceId, changed, 'EXPIRED');
  }
  return changed.length;
}

/**
 * Criterio 21: el proceso deja de estar ACTIVO → sus solicitudes pendientes pasan a REJECTED con
 * el motivo "contacta con la consulta", en la misma transacción que el cambio de estado.
 */
export async function rejectPendingRequestsOfProcess(tx: Tx, workspaceId: string, clinicalProcessId: string, actorId: string, cause: string) {
  const pending = await tx.appointmentRequest.findMany({ where: { workspaceId, clinicalProcessId, status: 'PENDING' }, orderBy: { id: 'asc' }, select: PENDING_SELECT });
  const changed = await closeRows(tx, workspaceId, pending, { status: 'REJECTED', rejectionReason: 'CONTACT_PRACTICE', resolvedById: actorId });
  if (changed.length) {
    await tx.auditLog.createMany({
      data: changed.map((row) => ({
        workspaceId, actorId, action: 'APPOINTMENT_REQUEST_REJECTED', entityType: 'AppointmentRequest', entityId: row.id,
        metadata: { patientId: row.patientId, therapistId: row.therapistId, type: row.type, reason: 'CONTACT_PRACTICE', cause, clinicalProcessId },
      })),
    });
    await notifyPatientOfRequestUpdates(tx, workspaceId, changed, 'REJECTED');
  }
  return changed.map((row) => row.id);
}

/**
 * Al aprobar una solicitud el hueco queda ocupado: las demás pendientes del mismo profesional que
 * se solapan con él ya no se podrán aprobar, así que se rechazan con SLOT_UNAVAILABLE en la misma
 * transacción (auditoría y aviso genérico al paciente).
 */
export async function rejectOverlappingPendingRequests(
  tx: Tx,
  workspaceId: string,
  params: { therapistId: string; startsAt: Date; endsAt: Date; excludeRequestId: string; actorId: string },
) {
  const overlapping = await tx.appointmentRequest.findMany({
    where: {
      workspaceId, therapistId: params.therapistId, status: 'PENDING', type: { in: ['NEW', 'RESCHEDULE'] },
      id: { not: params.excludeRequestId }, startsAt: { lt: params.endsAt }, endsAt: { gt: params.startsAt },
    },
    orderBy: { id: 'asc' },
    select: PENDING_SELECT,
  });
  const changed = await closeRows(tx, workspaceId, overlapping, { status: 'REJECTED', rejectionReason: 'SLOT_UNAVAILABLE', resolvedById: params.actorId });
  if (changed.length) {
    await tx.auditLog.createMany({
      data: changed.map((row) => ({
        workspaceId, actorId: params.actorId, action: 'APPOINTMENT_REQUEST_REJECTED', entityType: 'AppointmentRequest', entityId: row.id,
        metadata: { patientId: row.patientId, therapistId: row.therapistId, type: row.type, reason: 'SLOT_UNAVAILABLE', cause: 'SLOT_TAKEN_BY_APPROVAL', approvedRequestId: params.excludeRequestId },
      })),
    });
    await notifyPatientOfRequestUpdates(tx, workspaceId, changed, 'REJECTED');
  }
  return changed.map((row) => row.id);
}

/**
 * Criterio 22: archivar o bloquear al paciente, o desactivar su cuenta de portal, retira sus
 * solicitudes pendientes. Con `accountIds`, solo las hechas desde esas cuentas (cambio de modo de
 * acceso que revoca la cuenta del tutor, por ejemplo). Sin aviso al paciente: ya no tiene portal.
 */
export async function withdrawPendingRequestsOfPatient(
  tx: Tx,
  workspaceId: string,
  patientId: string,
  actorId: string | null,
  cause: string,
  accountIds?: string[],
) {
  if (accountIds && !accountIds.length) return [];
  const pending = await tx.appointmentRequest.findMany({
    where: { workspaceId, patientId, status: 'PENDING', ...(accountIds ? { requestedByAccountId: { in: accountIds } } : {}) },
    orderBy: { id: 'asc' },
    select: PENDING_SELECT,
  });
  const changed = await closeRows(tx, workspaceId, pending, { status: 'WITHDRAWN', ...(actorId ? { resolvedById: actorId } : {}) });
  if (changed.length) {
    await tx.auditLog.createMany({
      data: changed.map((row) => ({
        workspaceId, actorId, action: 'APPOINTMENT_REQUEST_WITHDRAWN', entityType: 'AppointmentRequest', entityId: row.id,
        metadata: { patientId: row.patientId, therapistId: row.therapistId, type: row.type, cause },
      })),
    });
  }
  return changed.map((row) => row.id);
}
