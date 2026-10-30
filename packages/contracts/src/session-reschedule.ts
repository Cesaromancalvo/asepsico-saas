/**
 * «Mover cita» desde la agenda: PATCH /sessions/:id/reschedule.
 *
 * Roles: OWNER, ADMIN y ASSISTANT sobre cualquier cita del espacio; THERAPIST solo sobre las suyas.
 * La respuesta 200 es el detalle de la sesión (GET /sessions/:id) con la hora nueva.
 *
 * Fechas: instantes ISO 8601 CON zona (`Z` o `+01:00`). La web convierte la hora local del espacio
 * (Workspace.timeZone, por defecto Europe/Madrid) a instante; una fecha sin zona → 400 de validación.
 */
export interface RescheduleSessionRequest {
  startsAt: string;
  endsAt: string;
}

export const SESSION_RESCHEDULE_ERROR_CODES = [
  /** 400: fin <= inicio, fecha inválida o más de 12 h de duración. */
  'INVALID_RANGE',
  /** 400: la hora nueva ya ha pasado. */
  'START_IN_PAST',
  /** 400: la hora nueva es igual a la actual. */
  'NO_CHANGE',
  /** 400: el profesional ya tiene otra cita no cancelada que se solapa. */
  'SESSION_OVERLAP',
  /** 400: el proceso clínico de la cita ya no está activo. */
  'PROCESS_NOT_ACTIVE',
  /** 403: un THERAPIST intenta mover la cita de otro profesional (queda auditado). */
  'NOT_OWN_SESSION',
  /** 404: la cita no existe en este espacio. */
  'SESSION_NOT_FOUND',
  /** 409: la cita está cerrada (realizada, ausencia) o cancelada. */
  'SESSION_NOT_SCHEDULED',
  /** 409: la cita ya ha empezado o es pasada. */
  'SESSION_ALREADY_STARTED',
  /** 409: hay una solicitud de cita del portal de otro paciente pendiente en esa franja. */
  'SLOT_NOT_AVAILABLE',
] as const;

export type SessionRescheduleErrorCode = (typeof SESSION_RESCHEDULE_ERROR_CODES)[number];

export interface SessionRescheduleError {
  statusCode: 400 | 403 | 404 | 409;
  error: string;
  code: SessionRescheduleErrorCode;
  message: string;
}
