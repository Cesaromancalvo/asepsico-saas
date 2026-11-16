/*
 * «¿Se hizo esta sesión?»: cierre rápido de las citas que ya han empezado y siguen programadas.
 *
 * API (ya existente): PATCH /sessions/:id/close con { status: 'COMPLETED' | 'NO_SHOW' | 'CANCELLED' }.
 * El cierre es definitivo (la API no deja volver a «Programada»). Solo cambia el estado: no pide ni
 * toca la nota de sesión, que se añade después desde el detalle de la cita como hasta ahora.
 *
 * Permisos (pista para la UI; el control real es del backend, assertCanManage en sessions.service):
 * OWNER, ADMIN y ASSISTANT (recepción) cierran cualquier cita del espacio; THERAPIST solo las suyas.
 * Cerrar una cita no muestra contenido clínico: solo fecha, hora y estado.
 */
import { api } from './api';
import type { Viewer } from './clinical';

export type SessionOutcome = 'COMPLETED' | 'NO_SHOW' | 'CANCELLED';

/** Lo mínimo de una cita para decidir si se pregunta «¿Se hizo esta sesión?». */
export type OutcomeSession = {
  id: string;
  status?: string | null;
  startsAt: string;
  therapistId?: string | null;
  therapist?: { id: string } | null;
};

export type OutcomeOption = {
  status: SessionOutcome;
  label: string;
  /** Texto de confirmación; null = se aplica con un clic (el caso habitual: la sesión se hizo). */
  confirm: string | null;
};

export const OUTCOME_QUESTION = '¿Se hizo esta sesión?';

export const OUTCOME_OPTIONS: readonly OutcomeOption[] = [
  { status: 'COMPLETED', label: 'Realizada', confirm: null },
  { status: 'NO_SHOW', label: 'No vino', confirm: '¿Marcar que el paciente no vino? No se puede deshacer.' },
  { status: 'CANCELLED', label: 'Cancelada', confirm: '¿Marcar la sesión como cancelada? No se puede deshacer.' },
];

/**
 * Aviso tras cerrar (role="status"). Si la sesión es de quien la cierra y se hizo, recuerda que la
 * nota se añade después (solo el profesional de la sesión puede escribirla; a recepción no se le dice).
 */
export function outcomeNotice(status: SessionOutcome, ownSession: boolean): string {
  if (status === 'COMPLETED') {
    return ownSession
      ? 'Sesión marcada como realizada. Puedes añadir la nota cuando quieras desde el detalle de la sesión.'
      : 'Sesión marcada como realizada.';
  }
  return status === 'NO_SHOW' ? 'Sesión marcada como «No vino».' : 'Sesión marcada como cancelada.';
}

/** ¿Es una cita de este usuario? (para el aviso de la nota). */
export function isOwnSession(session: Pick<OutcomeSession, 'therapistId' | 'therapist'>, viewer: Viewer | null): boolean {
  const therapistId = session.therapistId ?? session.therapist?.id ?? null;
  return Boolean(viewer?.userId) && therapistId === viewer?.userId;
}

/** ¿Ha empezado ya y sigue programada? (estado SCHEDULED y startsAt anterior a ahora). */
export function isAwaitingOutcome(session: Pick<OutcomeSession, 'status' | 'startsAt'>, now: Date = new Date()): boolean {
  if (session.status !== 'SCHEDULED') return false;
  const startsAt = new Date(session.startsAt).getTime();
  return Number.isFinite(startsAt) && startsAt < now.getTime();
}

/** ¿Deja la API a este usuario cerrar esta cita? THERAPIST solo las suyas; sin rol, nadie. */
export function canCloseSession(session: Pick<OutcomeSession, 'therapistId' | 'therapist'>, viewer: Viewer | null): boolean {
  if (!viewer?.role) return false;
  if (viewer.role === 'OWNER' || viewer.role === 'ADMIN' || viewer.role === 'ASSISTANT') return true;
  const therapistId = session.therapistId ?? session.therapist?.id ?? null;
  return viewer.role === 'THERAPIST' && Boolean(viewer.userId) && therapistId === viewer.userId;
}

/** Pregunta «¿Se hizo esta sesión?» solo si la cita está pendiente de cerrar y el usuario puede cerrarla. */
export function shouldAskOutcome(session: OutcomeSession, viewer: Viewer | null, now: Date = new Date()): boolean {
  return isAwaitingOutcome(session, now) && canCloseSession(session, viewer);
}

/**
 * ¿Se pregunta en la línea temporal de la ficha o del plan? Solo si quien mira TRATA al paciente
 * (proceso ACTIVO) y la parte clínica no se ha denegado. Con acceso excepcional (OWNER/ADMIN que no
 * trata al paciente) la ficha es de solo lectura: nunca se pregunta (revisión de Argos).
 */
export function outcomeEnabledForRecord(access: { treating: boolean }, clinicalDenied = false): boolean {
  return access.treating === true && !clinicalDenied;
}

/** Id de la cita de un evento SESSION de la línea temporal (GET /patients/:id/timeline usa «session-<id>»). */
export function timelineSessionId(event: { id: string; type: string }): string | null {
  return event.type === 'SESSION' && event.id.startsWith('session-') ? event.id.slice('session-'.length) || null : null;
}

/** Contexto accesible del grupo de botones: «Lucía Inventada, martes 17 de noviembre, 12:00». */
export function outcomeContext(patientName: string, startsAt: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return patientName;
  const parts = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  const when = `${parts.weekday} ${parts.day} de ${parts.month}, ${parts.hour}:${parts.minute}`;
  return patientName ? `${patientName}, ${when}` : when;
}

/** Cierra la cita con el estado elegido (sin notas). */
export function closeSessionOutcome(sessionId: string, status: SessionOutcome) {
  return api(`/sessions/${encodeURIComponent(sessionId)}/close`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}
