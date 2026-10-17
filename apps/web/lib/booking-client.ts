import type {
  AvailabilityViewContract,
  BlockReason,
  CreateBlockResponseContract,
  PortalAppointmentRequestContract,
  PortalBookingOptionsContract,
  PortalSlotsContract,
  RejectionReason,
  StaffAppointmentRequestContract,
  UpdateAvailabilityRequestContract,
} from '@asepsico/contracts';
import { api, ApiError } from './api';
import { PENDING_REQUESTS_EVENT } from './booking';

/*
 * Llamadas de la reserva de citas. Profesional: cliente `api` (cookies httpOnly + CSRF, renueva la
 * sesión en un 401). Portal: sesión de portal propia (cookies de portal + CSRF), así que no usa
 * `api`, que renovaría la sesión del personal.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const seg = encodeURIComponent;

/* ----------------------------- Profesional ----------------------------- */

export const getAvailability = (therapistId: string) => api<AvailabilityViewContract>(`/scheduling/availability/${seg(therapistId)}`);

export const saveAvailability = (therapistId: string, body: UpdateAvailabilityRequestContract) =>
  api<AvailabilityViewContract>(`/scheduling/availability/${seg(therapistId)}`, { method: 'PUT', body: JSON.stringify(body) });

export const setPortalBooking = (therapistId: string, enabled: boolean) =>
  api<AvailabilityViewContract>(`/scheduling/availability/${seg(therapistId)}/portal-booking`, { method: 'PATCH', body: JSON.stringify({ enabled }) });

export const createBlock = (therapistId: string, body: { startsAt: string; endsAt: string; reason: BlockReason }) =>
  api<CreateBlockResponseContract>(`/scheduling/availability/${seg(therapistId)}/blocks`, { method: 'POST', body: JSON.stringify(body) });

export const deleteBlock = (therapistId: string, blockId: string) =>
  api<{ ok: true }>(`/scheduling/availability/${seg(therapistId)}/blocks/${seg(blockId)}`, { method: 'DELETE' });

export const setTimeZone = (timeZone: string) =>
  api<{ timeZone: string }>('/scheduling/time-zone', { method: 'PATCH', body: JSON.stringify({ timeZone }) });

export const listRequests = (status?: 'PENDING') =>
  api<StaffAppointmentRequestContract[]>(`/scheduling/requests${status ? `?status=${status}` : ''}`);

export const approveRequest = (id: string) => api<StaffAppointmentRequestContract>(`/scheduling/requests/${seg(id)}/approve`, { method: 'POST' });

export const rejectRequest = (id: string, reason: RejectionReason) =>
  api<StaffAppointmentRequestContract>(`/scheduling/requests/${seg(id)}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });

export async function fetchPendingCount(): Promise<number> {
  const { pending } = await api<{ pending: number }>('/scheduling/requests/pending-count');
  return typeof pending === 'number' ? pending : 0;
}

/** Avisa a la barra lateral de que el contador de pendientes ha podido cambiar. */
export function notifyPendingChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PENDING_REQUESTS_EVENT));
}

/* ------------------------------- Portal -------------------------------- */

function csrfToken(): string {
  const match = typeof document === 'undefined' ? null : document.cookie.match(/(?:^|; )csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function portalRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const mutation = !!init.method && init.method.toUpperCase() !== 'GET';
  const response = await fetch(`${API_URL}/portal/booking${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(mutation ? { 'X-CSRF-Token': csrfToken() } : {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: unknown; code?: unknown };
    const message = Array.isArray(body.message) ? body.message.join('. ') : typeof body.message === 'string' ? body.message : '';
    throw new ApiError(message, response.status, typeof body.code === 'string' ? body.code : undefined);
  }
  return response.json() as Promise<T>;
}

export const portalOptions = () => portalRequest<PortalBookingOptionsContract>('/options');

export const portalSlots = (therapistId: string) => portalRequest<PortalSlotsContract>(`/slots?therapistId=${seg(therapistId)}`);

export const portalRequests = () => portalRequest<PortalAppointmentRequestContract[]>('/requests');

export const portalCreate = (therapistId: string, startsAt: string) =>
  portalRequest<PortalAppointmentRequestContract>('/requests', { method: 'POST', body: JSON.stringify({ therapistId, startsAt }) });

export const portalReschedule = (sessionId: string, startsAt: string) =>
  portalRequest<PortalAppointmentRequestContract>('/requests/reschedule', { method: 'POST', body: JSON.stringify({ sessionId, startsAt }) });

export const portalCancel = (sessionId: string) =>
  portalRequest<PortalAppointmentRequestContract>('/requests/cancel', { method: 'POST', body: JSON.stringify({ sessionId }) });

export const portalWithdraw = (requestId: string) =>
  portalRequest<PortalAppointmentRequestContract>(`/requests/${seg(requestId)}/withdraw`, { method: 'POST' });
