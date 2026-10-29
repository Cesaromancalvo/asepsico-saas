import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

/**
 * «Mover cita» (PATCH /sessions/:id/reschedule): errores con `code` estable para la web y
 * validación de la franja nueva. La lógica transaccional vive en SessionsService.reschedule.
 * Los códigos son los de packages/contracts/src/session-reschedule.ts (la API no depende del paquete).
 */

export type SessionRescheduleErrorCode =
  | 'INVALID_RANGE' | 'START_IN_PAST' | 'NO_CHANGE' | 'SESSION_OVERLAP' | 'PROCESS_NOT_ACTIVE'
  | 'NOT_OWN_SESSION' | 'SESSION_NOT_FOUND' | 'SESSION_NOT_SCHEDULED' | 'SESSION_ALREADY_STARTED' | 'SLOT_NOT_AVAILABLE';

/** Duración máxima de una cita movida (defensa ante errores de fecha; ninguna sesión dura más). */
export const MAX_SESSION_MINUTES = 12 * 60;

export function rescheduleError(status: 400 | 403 | 404 | 409, code: SessionRescheduleErrorCode, message: string) {
  if (status === 403) return new ForbiddenException({ statusCode: 403, error: 'Forbidden', code, message });
  if (status === 404) return new NotFoundException({ statusCode: 404, error: 'Not Found', code, message });
  if (status === 409) return new ConflictException({ statusCode: 409, error: 'Conflict', code, message });
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', code, message });
}

/** Franja nueva: fechas válidas, fin posterior al inicio, duración razonable y en el futuro. */
export function assertRescheduleTarget(
  target: { startsAt: Date; endsAt: Date },
  current: { startsAt: Date; endsAt: Date },
  now: Date,
) {
  const { startsAt, endsAt } = target;
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    throw rescheduleError(400, 'INVALID_RANGE', 'La hora de fin debe ser posterior a la de inicio');
  }
  if (endsAt.getTime() - startsAt.getTime() > MAX_SESSION_MINUTES * 60_000) {
    throw rescheduleError(400, 'INVALID_RANGE', 'Una cita no puede durar más de 12 horas');
  }
  if (startsAt <= now) {
    throw rescheduleError(400, 'START_IN_PAST', 'No se puede mover una cita a una hora que ya ha pasado');
  }
  if (startsAt.getTime() === current.startsAt.getTime() && endsAt.getTime() === current.endsAt.getTime()) {
    throw rescheduleError(400, 'NO_CHANGE', 'La cita ya está a esa hora');
  }
}
