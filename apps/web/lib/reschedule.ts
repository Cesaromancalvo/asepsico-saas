/*
 * «Mover cita» (cambiar fecha u hora de una cita programada) desde la agenda.
 *
 * API: PATCH /sessions/:id/reschedule con { startsAt, endsAt } (instantes ISO con zona), contrato en
 * docs/SESSION_RESCHEDULE_API.md y tipos en @asepsico/contracts. La fecha y la hora del formulario
 * son las de la consulta (Workspace.timeZone, GET /scheduling/time-zone; por defecto Europe/Madrid).
 *
 * Permisos (solo una pista para la UI; el control real es del backend):
 * OWNER, ADMIN y ASSISTANT (recepción) mueven cualquier cita del espacio; THERAPIST solo las suyas.
 * Mover una cita no toca ni muestra contenido clínico: solo fecha, hora y duración.
 */
import type { RescheduleSessionRequest, SessionRescheduleErrorCode } from '@asepsico/contracts';
import { api, ApiError } from './api';
import { zonedParts, zonedTimeToUtc } from './booking';
import type { Viewer } from './clinical';

export type { RescheduleSessionRequest, SessionRescheduleErrorCode };

export const DEFAULT_TIME_ZONE = 'Europe/Madrid';

let timeZoneCache: Promise<string> | null = null;

/** Zona horaria de la consulta (dato administrativo, para todo el personal). Un fallo no se cachea. */
export function fetchWorkspaceTimeZone(): Promise<string> {
  if (timeZoneCache) return timeZoneCache;
  const pending = api<{ timeZone?: string }>('/scheduling/time-zone')
    .then((r) => (typeof r?.timeZone === 'string' && r.timeZone ? r.timeZone : DEFAULT_TIME_ZONE))
    .catch(() => { timeZoneCache = null; return DEFAULT_TIME_ZONE; });
  timeZoneCache = pending;
  return pending;
}

/** Aviso que se da al confirmar: la API cierra solas las solicitudes del portal sobre esa cita. */
export const PENDING_REQUESTS_NOTICE = 'Si había solicitudes pendientes del paciente sobre esta cita, se cerrarán.';

/** Lo mínimo de una cita para decidir si se ofrece «Cambiar fecha u hora». */
export type ReschedulableSession = {
  id: string;
  therapistId?: string | null;
  therapist?: { id: string } | null;
  startsAt: string;
  endsAt: string;
  status?: string | null;
};

export const DURATION_OPTIONS = [30, 45, 50, 60, 90] as const;

/** ¿Puede este usuario mover esta cita? Programada, futura y con el rol adecuado. */
export function canRescheduleSession(
  session: ReschedulableSession,
  viewer: Viewer | null,
  now: Date = new Date(),
): boolean {
  if (!viewer?.role || session.status !== 'SCHEDULED') return false;
  if (new Date(session.startsAt).getTime() <= now.getTime()) return false;
  if (viewer.role === 'OWNER' || viewer.role === 'ADMIN' || viewer.role === 'ASSISTANT') return true;
  const therapistId = session.therapistId ?? session.therapist?.id ?? null;
  return viewer.role === 'THERAPIST' && Boolean(viewer.userId) && therapistId === viewer.userId;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Valores iniciales del formulario a partir de la cita, en la hora de la consulta. */
export function rescheduleDefaults(session: Pick<ReschedulableSession, 'startsAt' | 'endsAt'>, timeZone: string = DEFAULT_TIME_ZONE) {
  const minutes = Math.max(5, Math.round((new Date(session.endsAt).getTime() - new Date(session.startsAt).getTime()) / 60000));
  const { dateKey, minute } = zonedParts(session.startsAt, timeZone);
  return { date: dateKey, time: `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`, duration: minutes };
}

export type RescheduleForm = { date: string; time: string; duration: number };

/**
 * Convierte el formulario en el rango que se envía a la API. Comprueba en el navegador lo que se
 * puede comprobar sin preguntar (campos vacíos, hora pasada, sin cambios); el solape lo decide la API.
 */
export function buildRescheduleRange(
  form: RescheduleForm,
  current: Pick<ReschedulableSession, 'startsAt' | 'endsAt'>,
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): { range: RescheduleSessionRequest } | { error: string; field: 'date' | 'time' | 'duration' } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return { error: 'Indica la nueva fecha.', field: 'date' };
  if (!/^\d{2}:\d{2}$/.test(form.time)) return { error: 'Indica la nueva hora.', field: 'time' };
  if (!Number.isFinite(form.duration) || form.duration < 5 || form.duration > 720) {
    return { error: 'La duración no es válida.', field: 'duration' };
  }
  const [y, m, d] = form.date.split('-').map(Number);
  const [hh, mm] = form.time.split(':').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(probe.getTime()) || probe.getUTCDate() !== d || hh > 23 || mm > 59) return { error: 'La fecha no es válida.', field: 'date' };
  const start = new Date(zonedTimeToUtc(form.date, hh * 60 + mm, timeZone));
  if (start.getTime() <= now.getTime()) {
    return { error: 'Esa hora ya ha pasado. Elige una fecha y hora futuras.', field: 'time' };
  }
  const end = new Date(start.getTime() + form.duration * 60000);
  if (start.getTime() === new Date(current.startsAt).getTime() && end.getTime() === new Date(current.endsAt).getTime()) {
    return { error: 'Es la misma fecha, hora y duración que ya tiene la cita.', field: 'time' };
  }
  return { range: { startsAt: start.toISOString(), endsAt: end.toISOString() } };
}

const ERROR_MESSAGES: Record<SessionRescheduleErrorCode, string> = {
  INVALID_RANGE: 'La fecha, la hora o la duración no son válidas.',
  START_IN_PAST: 'Esa hora ya ha pasado. Elige una fecha y hora futuras.',
  NO_CHANGE: 'Es la misma fecha, hora y duración que ya tiene la cita.',
  SESSION_OVERLAP: 'Se solapa con otra cita de este profesional. Elige otra hora.',
  PROCESS_NOT_ACTIVE: 'El proceso de este paciente ya no está activo, así que la cita no se puede mover.',
  NOT_OWN_SESSION: 'Solo puedes mover tus propias citas.',
  SESSION_NOT_FOUND: 'Esta cita ya no existe. Vuelve a la agenda para ver la semana actualizada.',
  SESSION_NOT_SCHEDULED: 'Esta cita ya está cerrada o cancelada, así que no se puede mover.',
  SESSION_ALREADY_STARTED: 'Esta cita ya ha empezado, así que no se puede mover.',
  SLOT_NOT_AVAILABLE: 'Hay una solicitud pendiente de otro paciente en esa franja. Apruébala o recházala en «Solicitudes de cita», o elige otra hora.',
};

/** Error genérico para los 400 de validación, que no traen code (nota b de Argos). */
export const VALIDATION_ERROR_MESSAGE = 'No se ha podido cambiar la cita. Revisa la fecha y la hora.';

/** Mensaje claro para la pantalla a partir del error de la API. */
export function rescheduleErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.code as SessionRescheduleErrorCode | undefined;
    if (code && code in ERROR_MESSAGES) return ERROR_MESSAGES[code];
    if (err.status === 403) return 'No tienes permiso para mover esta cita.';
    if (err.status === 404) return ERROR_MESSAGES.SESSION_NOT_FOUND;
    // 400 de validación del DTO (sin code): nunca se enseña el texto técnico del servidor.
    if (err.status === 400) return VALIDATION_ERROR_MESSAGE;
  }
  return 'No se pudo cambiar la cita. Revisa tu conexión y vuelve a intentarlo.';
}

/** Campo al que llevar el foco según el error (el solape y la hora pasada, a la hora). */
export function rescheduleErrorField(err: unknown): 'date' | 'time' | 'duration' | null {
  const code = err instanceof ApiError ? err.code : undefined;
  if (code === 'SESSION_OVERLAP' || code === 'START_IN_PAST' || code === 'SLOT_NOT_AVAILABLE' || code === 'NO_CHANGE') return 'time';
  if (code === 'INVALID_RANGE') return 'duration';
  return null;
}

export function rescheduleSession<T = unknown>(sessionId: string, body: RescheduleSessionRequest): Promise<T> {
  return api<T>(`/sessions/${encodeURIComponent(sessionId)}/reschedule`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** Lunes (00:00 local) de la semana de una fecha, en "AAAA-MM-DD", para abrir la agenda en esa semana. */
export function weekKeyOf(iso: string): string {
  const date = new Date(iso);
  const day = date.getDay();
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Agenda abierta en la semana de la cita (`?semana=AAAA-MM-DD`). */
export function agendaWeekHref(iso: string): string {
  return `/agenda/?semana=${weekKeyOf(iso)}`;
}

/** Fecha larga para los avisos: «jueves, 5 de noviembre a las 10:00» (hora de la consulta). */
export function rescheduleNoticeDate(iso: string, timeZone: string = DEFAULT_TIME_ZONE): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(date);
  const time = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone }).format(date);
  return `${day} a las ${time}`;
}
