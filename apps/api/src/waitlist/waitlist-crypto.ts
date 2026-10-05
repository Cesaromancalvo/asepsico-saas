import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WAITLIST_FORM_MAX_AGE_SECONDS, WAITLIST_FORM_MIN_SECONDS, waitlistSubkey } from './waitlist.config';

/**
 * Normalización mínima y predecible del email para deduplicar: sin espacios, NFKC y minúsculas.
 * No se quitan puntos ni "+etiqueta" (eso depende de cada proveedor y uniría personas distintas).
 */
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFKC').toLowerCase();
}

/**
 * HMAC-SHA256 (no un hash simple: un SHA-256 de un email se revierte con un diccionario de
 * emails). Determinista para poder buscar por él; la clave sale de WAITLIST_SECRET.
 */
export function hashWaitlistEmail(email: string, env: NodeJS.ProcessEnv = process.env): string {
  return createHmac('sha256', waitlistSubkey('email-hash-v1', env)).update(normalizeEmail(email)).digest('hex');
}

/**
 * Token de formulario sin estado ni cookies: "<emitidoEnMs>.<nonce>.<firma>". Demuestra que el
 * envío viene de alguien que pidió el formulario hace al menos WAITLIST_FORM_MIN_SECONDS (un bot
 * que hace POST directo no lo tiene; uno que lo pide tiene que esperar). No identifica a nadie.
 */
function sign(payload: string, env: NodeJS.ProcessEnv): string {
  return createHmac('sha256', waitlistSubkey('form-token-v1', env)).update(payload).digest('base64url');
}

export function issueFormToken(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const payload = `${now}.${randomBytes(9).toString('base64url')}`;
  return `${payload}.${sign(payload, env)}`;
}

export type FormTokenCheck = 'ok' | 'invalid' | 'too-fast';

export function checkFormToken(token: string | undefined, now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): FormTokenCheck {
  if (!token) return 'invalid';
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d{1,15}$/.test(parts[0])) return 'invalid';
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, env));
  const received = Buffer.from(parts[2]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return 'invalid';
  const ageSeconds = (now - Number(parts[0])) / 1000;
  // Margen de 5 s por si hubiera varias instancias con relojes ligeramente distintos.
  if (ageSeconds < -5 || ageSeconds > WAITLIST_FORM_MAX_AGE_SECONDS) return 'invalid';
  if (ageSeconds < WAITLIST_FORM_MIN_SECONDS) return 'too-fast';
  return 'ok';
}
