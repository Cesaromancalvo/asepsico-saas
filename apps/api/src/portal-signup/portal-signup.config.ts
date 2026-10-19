import { createHash, randomBytes } from 'crypto';

/**
 * Alta en el portal con el QR FIJO del profesional (docs/producto/whatsapp-y-alta-qr.md, Parte B,
 * rediseñada el 18/10: un QR por profesional, impreso en la consulta).
 *
 * Valores fijos en el servidor: el cliente nunca los elige.
 */

/** Prefijo de las rutas públicas (main.ts les aplica el límite de cuerpo de 16 KB). */
export const PORTAL_SIGNUP_PUBLIC_PATH = '/api/v1/public/portal-signup';

/** Las solicitudes sin respuesta se borran a los 14 días. */
export const SIGNUP_REQUEST_TTL_MS = 14 * 24 * 60 * 60_000;
/** Solicitudes pendientes como máximo por profesional (las siguientes se descartan en silencio). */
export const MAX_PENDING_REQUESTS_PER_PROFESSIONAL = 20;
/** Solicitudes como máximo por QR y hora (las siguientes se descartan en silencio). */
export const MAX_REQUESTS_PER_LINK_PER_HOUR = 10;
/** Vida del enlace de activación (poner contraseña) que se entrega al aceptar la solicitud. */
export const ACTIVATION_TTL_MS = 72 * 60 * 60_000;
/** C6 (Lex Psi): sin alta autónoma por debajo de 16 años; con 16–17 hasta que responda el abogado se recomienda manual. */
export const MIN_SIGNUP_AGE_YEARS = 16;

/**
 * Versiones vigentes de los textos de la pantalla de alta (información art. 13 en capa 1 y normas
 * de uso del portal). Los textos viven en el material privado de Lex Psi; aquí solo la versión
 * que el frontend debe mostrar y devolver. Cambiar el texto obliga a subir la versión.
 */
export const PORTAL_SIGNUP_NOTICE_VERSIONS = {
  privacyNotice: 'portal-info-art13-borrador-2026-10',
  portalTerms: 'portal-normas-uso-borrador-2026-10',
} as const;

/** Límites por IP (ThrottlerGuard global; la clave es req.ip, ver trust proxy en main.ts). */
export const SIGNUP_SUBMIT_THROTTLE = { default: { limit: 10, ttl: 60 * 60_000 } };
export const ACTIVATION_THROTTLE = { default: { limit: 10, ttl: 60 * 60_000 } };

/** Respuesta ÚNICA del envío público: idéntica con token válido, inválido, rotado o descartado. */
export const SIGNUP_ACCEPTED_RESPONSE = Object.freeze({
  ok: true,
  message: 'Hemos recibido tu solicitud. Tu consulta la revisará y te dará el enlace para activar tu cuenta.',
});

export const ACTIVATION_INVALID_MESSAGE = 'Este enlace ya no es válido. Pide otro a tu consulta.';

/** Token aleatorio de 256 bits en base64url (43 caracteres). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 (hex). Basta un hash simple: el token tiene 256 bits de entropía (no es un diccionario). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Formato exacto de un token emitido por generateToken. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Edad cumplida en `now` para una fecha AAAA-MM-DD (en UTC, sin horas). */
export function ageInYears(birthDate: string, now: Date = new Date()): number {
  const [y, m, d] = birthDate.slice(0, 10).split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  const monthDiff = now.getUTCMonth() + 1 - m;
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < d)) age -= 1;
  return age;
}

/** Fecha de un Date como AAAA-MM-DD (UTC), para comparar con la de la solicitud. */
export function isoDay(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  const value = date instanceof Date ? date : new Date(date);
  return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
}

/** Normaliza un nombre para comparar: sin tildes, minúsculas y espacios simples. */
export function normalizeName(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
