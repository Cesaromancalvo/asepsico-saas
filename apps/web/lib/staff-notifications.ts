/*
 * Avisos del personal dentro de la app (campana y «Cambios de agenda» en Mi jornada).
 *
 * API (contrato en docs/STAFF_NOTIFICATIONS_API.md, tipos en @asepsico/contracts):
 *   GET   /notifications?unreadOnly=true   → StaffNotification[] (máx. 100, más recientes primero)
 *   GET   /notifications/unread-count      → { unread }
 *   PATCH /notifications/:id/read          → { ok: true }
 *   POST  /notifications/read-all          → { ok: true, updated }
 *
 * Cliente `api`: cookies httpOnly + CSRF y renovación de sesión en un 401. Nada se guarda en el
 * navegador (ni localStorage ni la URL): el contador y la lista viven en memoria del componente.
 *
 * Privacidad: `body` ya viene compuesto por la API con el acceso de agenda del lector (OWNER, ADMIN y
 * recepción ven las citas del espacio; un THERAPIST solo las suyas). La web no añade nada: solo
 * título, texto y, en los cambios de cita, el enlace a la agenda o a la solicitud.
 */
import type { AppointmentChangeKind, StaffNotification, StaffNotificationsReadAll, StaffNotificationsUnreadCount } from '@asepsico/contracts';
import { api } from './api';
import { setAgendaFocus } from './agenda-focus';
import { formatClinicalAccessNotice, safeInternalPath } from './exceptional-access';

export type { AppointmentChangeKind, StaffNotification };

const seg = encodeURIComponent;

/** Evento del navegador: «el contador o la lista de avisos han podido cambiar». */
export const STAFF_NOTIFICATIONS_EVENT = 'asepsico:staff-notifications-changed';

export function notifyStaffNotificationsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(STAFF_NOTIFICATIONS_EVENT));
}

export async function fetchUnreadCount(): Promise<number> {
  const { unread } = await api<StaffNotificationsUnreadCount>('/notifications/unread-count', {}, { background: true });
  return typeof unread === 'number' && unread > 0 ? unread : 0;
}

export async function listStaffNotifications(unreadOnly = false): Promise<StaffNotification[]> {
  const items = await api<StaffNotification[]>(`/notifications${unreadOnly ? '?unreadOnly=true' : ''}`);
  return Array.isArray(items) ? items : [];
}

export async function markNotificationRead(id: string): Promise<void> {
  await api<{ ok: true }>(`/notifications/${seg(id)}/read`, { method: 'PATCH' });
  notifyStaffNotificationsChanged();
}

export async function markAllNotificationsRead(): Promise<number> {
  const result = await api<StaffNotificationsReadAll>('/notifications/read-all', { method: 'POST' });
  notifyStaffNotificationsChanged();
  return typeof result?.updated === 'number' ? result.updated : 0;
}

export const isUnread = (n: Pick<StaffNotification, 'readAt' | 'status'>) => !n.readAt && n.status !== 'READ';

/** Texto accesible del contador: «3 avisos sin leer». */
export function unreadLabel(count: number): string {
  if (count <= 0) return 'Sin avisos nuevos';
  return count === 1 ? '1 aviso sin leer' : `${count} avisos sin leer`;
}

/** Número del globo: nunca más de dos cifras. */
export const badgeText = (count: number) => (count > 99 ? '99+' : String(count));

/** Etiqueta corta del tipo de cambio (chip). Sin datos del paciente. */
export const CHANGE_LABEL: Record<AppointmentChangeKind, string> = {
  RESCHEDULED_BY_STAFF: 'Cita movida',
  CANCELLED_BY_STAFF: 'Cita cancelada',
  PATIENT_REQUESTED_RESCHEDULE: 'Pide cambiar la cita',
  PATIENT_REQUESTED_CANCEL: 'Pide cancelar la cita',
  PATIENT_WITHDREW_REQUEST: 'Petición retirada',
  REQUEST_APPROVED: 'Solicitud aprobada',
  REQUEST_REJECTED: 'Solicitud rechazada',
};

/** Color del chip según el tipo de cambio (clases del design system). */
export function changeTone(change: AppointmentChangeKind): 'chip-violet' | 'chip-amber' | 'chip-red' | 'chip-green' | 'chip-neutral' {
  switch (change) {
    case 'CANCELLED_BY_STAFF':
    case 'PATIENT_REQUESTED_CANCEL':
      return 'chip-red';
    case 'PATIENT_REQUESTED_RESCHEDULE':
      return 'chip-amber';
    case 'REQUEST_APPROVED':
      return 'chip-green';
    case 'PATIENT_WITHDREW_REQUEST':
    case 'REQUEST_REJECTED':
      return 'chip-neutral';
    default:
      return 'chip-violet';
  }
}

export const REQUESTS_PATH = '/agenda/solicitudes/';
export const AGENDA_PATH = '/agenda/';

/** A dónde lleva pulsar un aviso. */
export type NoticeTarget =
  | { kind: 'agenda'; label: 'Ver en la agenda'; sessionId: string; startsAt: string }
  | { kind: 'requests'; label: 'Ver solicitud'; href: string }
  | { kind: 'link'; label: 'Abrir'; href: string }
  | null;

const PATIENT_REQUESTS = new Set<AppointmentChangeKind>(['PATIENT_REQUESTED_RESCHEDULE', 'PATIENT_REQUESTED_CANCEL']);

/**
 * Destino de un aviso.
 * - Peticiones del paciente pendientes → bandeja de Solicitudes (ahí se aprueban o rechazan).
 * - Resto de cambios de cita con cita visible → la semana de la cita en la agenda, resaltada.
 *   Hora: la nueva (to) si la hay; si no (cancelación), la anterior (from).
 * - Sin cita visible (la API puso los datos a null) → Solicitudes si hay solicitud; si no, el
 *   enlace interno del aviso (`actionUrl`, solo rutas propias) o nada.
 */
export function noticeTarget(n: Pick<StaffNotification, 'appointmentChange' | 'actionUrl'>): NoticeTarget {
  const change = n.appointmentChange;
  if (change) {
    if (PATIENT_REQUESTS.has(change.change) && change.requestId) {
      return { kind: 'requests', label: 'Ver solicitud', href: REQUESTS_PATH };
    }
    const slot = change.to ?? change.from;
    if (change.sessionId && slot?.startsAt) {
      return { kind: 'agenda', label: 'Ver en la agenda', sessionId: change.sessionId, startsAt: slot.startsAt };
    }
    if (change.requestId) return { kind: 'requests', label: 'Ver solicitud', href: REQUESTS_PATH };
  }
  const href = safeInternalPath(n.actionUrl);
  if (!href) return null;
  if (change) {
    // Aviso de cita sin datos visibles: a la agenda o a la bandeja, nunca a otra pantalla.
    return href.startsWith('/agenda/solicitudes')
      ? { kind: 'requests', label: 'Ver solicitud', href: REQUESTS_PATH }
      : { kind: 'link', label: 'Abrir', href: AGENDA_PATH };
  }
  return { kind: 'link', label: 'Abrir', href };
}

/** «hace 5 min», «hace 2 h», «ayer», «3 nov.». */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const diff = now.getTime() - date.getTime();
  if (Number.isNaN(diff)) return '';
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'ayer';
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(date);
}

/** Texto del aviso tal y como se muestra (los de acceso excepcional traen la fecha en ISO). */
export function noticeBody(n: Pick<StaffNotification, 'type' | 'body'>): string {
  return n.type === 'CLINICAL_ACCESS_NOTICE' ? formatClinicalAccessNotice(n.body) : n.body;
}

/**
 * Pulsar un aviso: se marca como leído (si falla, se navega igual; la próxima carga lo dirá) y se
 * va a su destino. «Ver en la agenda» deja en memoria qué cita resaltar (ver agenda-focus).
 */
export async function openNotice(n: StaffNotification, push: (href: string) => void): Promise<void> {
  const target = noticeTarget(n);
  if (isUnread(n)) await markNotificationRead(n.id).catch(() => undefined);
  if (!target) return;
  if (target.kind === 'agenda') {
    setAgendaFocus(target.sessionId, target.startsAt);
    push(AGENDA_PATH);
    return;
  }
  push(target.href);
}
