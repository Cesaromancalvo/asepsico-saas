import { Prisma } from '@prisma/client';

/**
 * Serialización de la agenda por profesional (y de las solicitudes por paciente) con advisory
 * locks de transacción de PostgreSQL: se liberan solos en el commit o en el rollback.
 *
 * Todo lo que crea o mueve ocupación de la agenda de un profesional (alta o reprogramación desde
 * la agenda, solicitud del portal, aprobación, bloqueo) toma este lock ANTES de comprobar solapes
 * y escribir, en la misma transacción. Así la comprobación y la escritura son atómicas.
 *
 * Orden fijo para evitar interbloqueos: primero el del paciente (si hace falta), después el del
 * profesional.
 */
async function advisoryLock(tx: Prisma.TransactionClient, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export function lockTherapistSchedule(tx: Prisma.TransactionClient, workspaceId: string, therapistId: string) {
  return advisoryLock(tx, `schedule:${workspaceId}:${therapistId}`);
}

export function lockPatientBooking(tx: Prisma.TransactionClient, workspaceId: string, patientId: string) {
  return advisoryLock(tx, `booking:${workspaceId}:${patientId}`);
}

export type ScheduleConflict = 'SESSION' | 'REQUEST' | 'BLOCK';

/**
 * Primer motivo por el que [startsAt, endsAt) no está libre en la agenda del profesional, o null.
 * Llamar SIEMPRE con el lock del profesional tomado en la misma transacción.
 */
export async function findScheduleConflict(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    therapistId: string;
    startsAt: Date;
    endsAt: Date;
    excludeSessionId?: string;
    excludeRequestId?: string;
    includeBlocks: boolean;
    now?: Date;
  },
): Promise<ScheduleConflict | null> {
  const { workspaceId, therapistId, startsAt, endsAt } = params;
  const overlap = { startsAt: { lt: endsAt }, endsAt: { gt: startsAt } };

  const session = await tx.session.findFirst({
    where: {
      workspaceId,
      therapistId,
      status: { not: 'CANCELLED' },
      ...(params.excludeSessionId ? { id: { not: params.excludeSessionId } } : {}),
      ...overlap,
    },
    select: { id: true },
  });
  if (session) return 'SESSION';

  const request = await tx.appointmentRequest.findFirst({
    where: {
      workspaceId,
      therapistId,
      status: 'PENDING',
      type: { in: ['NEW', 'RESCHEDULE'] },
      expiresAt: { gt: params.now ?? new Date() },
      ...(params.excludeRequestId ? { id: { not: params.excludeRequestId } } : {}),
      ...overlap,
    },
    select: { id: true },
  });
  if (request) return 'REQUEST';

  if (params.includeBlocks) {
    const block = await tx.availabilityBlock.findFirst({ where: { workspaceId, therapistId, ...overlap }, select: { id: true } });
    if (block) return 'BLOCK';
  }
  return null;
}
