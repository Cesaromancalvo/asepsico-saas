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

/** Edad mínima para el alta autónoma por QR (C6). Igual que MIN_SIGNUP_AGE_YEARS de la API. */
export const MIN_SIGNUP_AGE = 16;

/**
 * Versiones de los textos de la pantalla de alta. Deben coincidir con
 * PORTAL_SIGNUP_NOTICE_VERSIONS de apps/api/src/portal-signup/portal-signup.config.ts (lo
 * comprueba test/portal-signup.spec.ts). Cambiar un texto obliga a subir su versión en los dos.
 */
export const PORTAL_SIGNUP_NOTICE_VERSIONS = {
  privacyNotice: 'portal-info-art13-borrador-2026-10',
  portalTerms: 'portal-normas-uso-borrador-2026-10',
} as const;

/**
 * Información art. 13, capa 1 (BORRADOR pendiente de Lex Psi y del abogado). No nombra la
 * consulta ni al profesional: la pantalla pública no debe revelar a quién pertenece el QR.
 */
export const PRIVACY_NOTICE_LAYER1: { title: string; items: { term: string; text: string }[] } = {
  title: 'Información sobre tus datos',
  items: [
    { term: 'Responsable', text: 'La consulta de psicología que te ha facilitado este código QR.' },
    { term: 'Qué datos', text: 'Tu nombre y apellidos, tu correo, tu teléfono si lo indicas y tu fecha de nacimiento, además de datos técnicos de acceso.' },
    { term: 'Para qué', text: 'Para que tu consulta compruebe tu identidad y te dé acceso a tu portal de paciente.' },
    { term: 'Cuánto tiempo', text: 'Si tu consulta no responde a la solicitud en 14 días, se borra. Si la acepta, tus datos pasan a tu ficha de paciente.' },
    { term: 'Tus derechos', text: 'Puedes pedir a tu consulta acceder a tus datos, corregirlos, suprimirlos u oponerte a su uso. También puedes reclamar ante la Agencia Española de Protección de Datos.' },
  ],
};

/** Normas de uso del portal (BORRADOR). */
export const PORTAL_TERMS_SUMMARY: string[] = [
  'El portal es personal: no compartas tu contraseña.',
  'No es un canal de urgencias. Si lo necesitas, llama al 024 (atención a la conducta suicida) o al 112.',
  'Tu consulta responderá en su horario habitual.',
];

/** Textos de las dos casillas (desmarcadas). El primero es un acuse de lectura, no un consentimiento. */
export const PRIVACY_ACK_LABEL = 'He leído la información sobre cómo se tratan mis datos.';
export const PORTAL_TERMS_LABEL = 'Acepto las normas de uso del portal.';

/** Formato de los tokens emitidos por la API (256 bits en base64url). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Lee `t` del fragmento (#t=...). El fragmento nunca llega al servidor ni a los registros. */
export function tokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('t');
  return token && TOKEN_RE.test(token) ? token : null;
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

export const MINOR_SIGNUP_MESSAGE = 'Con menos de 16 años el alta la hace tu consulta contigo y con tu madre, padre o tutor.';

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

/* ----------------------------- Formato ----------------------------- */

export function formatDay(value: string): string {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
