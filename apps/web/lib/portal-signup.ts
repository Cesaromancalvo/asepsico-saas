import type {
  PortalActivationBody,
  PortalIntakeLinkContract,
  PortalSignupAcceptedContract,
  PortalSignupAcceptedResponse,
  PortalSignupBulkRejectResult,
  PortalSignupLinkWarning,
  PortalSignupRequestBody,
  PortalSignupRequestContract,
} from '@asepsico/contracts';
import { api } from './api';

/*
 * Alta en el portal con el QR fijo de cada profesional (docs/producto/whatsapp-y-alta-qr.md,
 * Parte B rediseñada el 18/10). El paciente escanea, deja sus datos y la consulta revisa la
 * solicitud. Al aceptarla se emite un enlace de activación que se entrega SOLO en persona.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const seg = encodeURIComponent;

/** Edad mínima para el alta por QR (piloto: 18). Igual que MIN_SIGNUP_AGE_YEARS de la API. */
export const MIN_SIGNUP_AGE = 18;

/**
 * Versiones de los textos de la pantalla de alta (lib/portal-signup-texts.ts). Deben coincidir con
 * PORTAL_SIGNUP_NOTICE_VERSIONS de apps/api/src/portal-signup/portal-signup.config.ts (lo
 * comprueba test/portal-signup.spec.tsx). Cambiar un texto obliga a subir su versión en los dos.
 */
export const PORTAL_SIGNUP_NOTICE_VERSIONS = {
  privacyNotice: 'portal-alta-qr-art13-v1.0-borrador-2026-10-20',
  portalTerms: 'portal-normas-uso-v1.0-borrador-2026-10-20',
} as const;

/** Formato de los tokens emitidos por la API (256 bits en base64url). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Lee `t` del fragmento (#t=...). El fragmento nunca llega al servidor ni a los registros. */
export function tokenFromHash(hash: string): string | null {
  // Solo el fragmento: un ?t= (que sí llega al servidor y a los registros) no vale.
  if (!hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('t');
  return token && TOKEN_RE.test(token) ? token : null;
}

type LocationLike = { location: { hash: string; pathname: string }; history: { replaceState(data: unknown, unused: string, url?: string): void } };

/**
 * Lee el token del fragmento y lo quita EN EL ACTO de la URL (condición de Argos): así no queda en
 * el historial ni en pestañas sincronizadas aunque la persona abandone la página o falle la red.
 */
export function takeTokenFromLocation(win: LocationLike): string | null {
  const token = tokenFromHash(win.location.hash);
  if (win.location.hash) win.history.replaceState(null, '', win.location.pathname);
  return token;
}

/** Enlace que codifica el QR fijo del profesional. */
export function intakeUrl(origin: string, token: string): string {
  return `${origin}/portal/alta#t=${token}`;
}

/** Enlace de activación (poner contraseña) que se entrega en persona. */
export function activationUrl(origin: string, token: string): string {
  return `${origin}/portal/activar#t=${token}`;
}

/** Edad cumplida hoy para una fecha AAAA-MM-DD (mismo cálculo que la API, en UTC). */
export function ageInYears(birthDate: string, now: Date = new Date()): number {
  const [y, m, d] = birthDate.slice(0, 10).split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  const monthDiff = now.getUTCMonth() + 1 - m;
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < d)) age -= 1;
  return age;
}

export const MINOR_SIGNUP_MESSAGE = `El alta con este código es para mayores de ${MIN_SIGNUP_AGE} años. Pide a tu consulta que te dé de alta en persona.`;

/** Mensajes de los avisos al vincular (409 PORTAL_SIGNUP_CONFIRMATION_REQUIRED). */
export const LINK_WARNING_LABEL: Record<PortalSignupLinkWarning, string> = {
  EMAIL_MISMATCH: 'El correo de la solicitud no coincide con el de la ficha.',
  PHONE_MISMATCH: 'El teléfono de la solicitud no coincide con el de la ficha.',
  PORTAL_PREVIOUSLY_DISABLED: 'Este paciente tuvo el acceso al portal desactivado.',
};

export function isLinkWarning(value: unknown): value is PortalSignupLinkWarning {
  return typeof value === 'string' && value in LINK_WARNING_LABEL;
}

/* ----------------------------- Personal de la consulta ----------------------------- */

/** Fila de la bandeja con la marca de profesional dado de baja (la añade la API). */
export type SignupRequest = PortalSignupRequestContract & { professionalRemoved?: boolean };

export const getIntakeLink = (professionalId: string) =>
  api<PortalIntakeLinkContract>(`/portal-intake-links/${seg(professionalId)}`);

export const rotateIntakeLink = (professionalId: string) =>
  api<PortalIntakeLinkContract>(`/portal-intake-links/${seg(professionalId)}/rotate`, { method: 'POST' });

export const disableIntakeLink = (professionalId: string) =>
  api<{ professionalId: string; isActive: false }>(`/portal-intake-links/${seg(professionalId)}`, { method: 'DELETE' });

export const listSignupRequests = (professionalId?: string) =>
  api<SignupRequest[]>(`/portal-signup-requests${professionalId ? `?professionalId=${seg(professionalId)}` : ''}`);

export const acceptCreatingPatient = (requestId: string) =>
  api<PortalSignupAcceptedContract>(`/portal-signup-requests/${seg(requestId)}/create-patient`, { method: 'POST' });

export const acceptLinkingPatient = (requestId: string, patientId: string, confirmWarnings?: PortalSignupLinkWarning[]) =>
  api<PortalSignupAcceptedContract>(`/portal-signup-requests/${seg(requestId)}/link`, {
    method: 'POST',
    body: JSON.stringify({ patientId, ...(confirmWarnings?.length ? { confirmWarnings } : {}) }),
  });

export const rejectSignupRequest = (requestId: string) =>
  api<{ ok: true }>(`/portal-signup-requests/${seg(requestId)}/reject`, { method: 'POST' });

export const rejectSignupRequests = (requestIds: string[]) =>
  api<PortalSignupBulkRejectResult>('/portal-signup-requests/bulk-reject', { method: 'POST', body: JSON.stringify({ requestIds }) });

export const reissueActivation = (patientId: string) =>
  api<PortalSignupAcceptedContract>(`/patients/${seg(patientId)}/portal-account/activation-link`, { method: 'POST' });

/* ----------------------------- Público (sin sesión) ----------------------------- */

export class PublicRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'PublicRequestError';
  }
}

/**
 * Endpoints públicos: sin cookies (credentials: 'omit') para no mezclarlos nunca con una sesión
 * del personal abierta en el mismo navegador, y sin el cliente `api`, que intentaría renovarla.
 */
async function publicPost<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PublicRequestError('No hemos podido conectar. Revisa tu conexión y vuelve a intentarlo.', 0);
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof data.code === 'string' ? data.code : undefined;
    let message = Array.isArray(data.message) ? data.message.join('. ') : typeof data.message === 'string' ? data.message : '';
    if (response.status === 429) message = 'Has hecho demasiados intentos seguidos. Espera un rato y vuelve a intentarlo.';
    throw new PublicRequestError(message || 'No se ha podido enviar. Vuelve a intentarlo.', response.status, code);
  }
  return data as T;
}

export const submitSignupRequest = (body: PortalSignupRequestBody) =>
  publicPost<PortalSignupAcceptedResponse>('/public/portal-signup/requests', body);

export const activatePortalAccount = (body: PortalActivationBody) =>
  publicPost<{ ok: true }>('/public/portal-signup/activate', body);

export type SignupFormInput = { firstName: string; lastName: string; email: string; phone: string; birthDate: string };
export type SignupOutcome = { step: 'sent'; message: string } | { step: 'minor' } | { step: 'error'; message: string };

/**
 * Envío de la solicitud desde el formulario público. Por debajo de la edad mínima devuelve
 * 'minor' SIN llamar a la API: ningún dato de un menor sale del navegador.
 */
export async function sendSignupRequest(token: string, input: SignupFormInput, send = submitSignupRequest): Promise<SignupOutcome> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate)) return { step: 'error', message: 'Indica tu fecha de nacimiento.' };
  if (ageInYears(input.birthDate) < MIN_SIGNUP_AGE) return { step: 'minor' };
  const phone = input.phone.trim();
  try {
    const result = await send({
      token,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      email: input.email.trim(),
      ...(phone ? { phone } : {}),
      birthDate: input.birthDate,
      privacyNoticeAcknowledged: true,
      portalTermsAccepted: true,
      privacyNoticeVersion: PORTAL_SIGNUP_NOTICE_VERSIONS.privacyNotice,
      portalTermsVersion: PORTAL_SIGNUP_NOTICE_VERSIONS.portalTerms,
    });
    return { step: 'sent', message: result.message };
  } catch (err) {
    if (err instanceof PublicRequestError && err.code === 'PORTAL_SIGNUP_MIN_AGE') return { step: 'minor' };
    if (err instanceof PublicRequestError && err.status === 400) return { step: 'error', message: 'Revisa los datos: hay algún campo con un formato no válido.' };
    return { step: 'error', message: err instanceof Error && err.message ? err.message : 'No se ha podido enviar. Vuelve a intentarlo.' };
  }
}

/* ----------------------------- Formato ----------------------------- */

export function formatDay(value: string): string {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
