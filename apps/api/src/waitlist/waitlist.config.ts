import { createHmac } from 'node:crypto';

/**
 * Configuración de la lista de espera pública (POST /api/v1/public/waitlist).
 *
 * Variables de entorno:
 *  - WAITLIST_ALLOWED_ORIGINS: orígenes (esquema://host[:puerto], sin ruta) que pueden llamar al
 *    endpoint desde el navegador, separados por comas. Vacío = asepsico.es y www.asepsico.es.
 *    En producción solo se admite https.
 *  - WAITLIST_SECRET: secreto (>= 32 caracteres) del que se derivan, por separado, la clave del
 *    hash de deduplicación del email y la de firma del token de formulario. Obligatorio en
 *    producción (la API no arranca sin él). Cambiarlo rompe la deduplicación de las altas previas.
 *  - WAITLIST_V5_ACCEPTED_UNTIL: fin de la transición de la política lista-espera-v5 (opcional, máx.
 *    7 días; ver waitlistV5AcceptedUntil). Sin ella, la v5 está retirada.
 */

export const WAITLIST_PATH = '/api/v1/public/waitlist';

export const DEFAULT_WAITLIST_ORIGINS = ['https://asepsico.es', 'https://www.asepsico.es'];

/**
 * Versiones de la política de privacidad de la lista de espera que la API acepta. La landing
 * envía la versión que ha mostrado y se guarda tal cual. Al publicar una política nueva: añadir
 * su versión aquí (y en packages/contracts), desplegar la API y DESPUÉS la landing; retirar la
 * anterior (pasarla a RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS) cuando la landing ya no la sirva.
 *
 * Vigente: lista-espera-v6 (decisión del Jefe del 03/11/2026; texto de Lex Psi, revisión 1.0 del
 * 03/11/2026, pendiente del abogado humano). Teléfono OPCIONAL con preferencia de contacto
 * obligatoria y sin valor por defecto (contactPreference):
 *  - PHONE_AND_EMAIL: teléfono obligatorio (WAITLIST_PHONE_REQUIRED / WAITLIST_PHONE_INVALID), en E.164
 *    y cifrado. Es el consentimiento previo a las llamadas (art. 66.1.b LGTel).
 *  - EMAIL_ONLY: el teléfono NO puede llegar (WAITLIST_PHONE_NOT_ALLOWED; minimización, art. 5.1.c).
 *  - Sin preferencia → WAITLIST_CONTACT_PREFERENCE_REQUIRED.
 *
 * Transición: lista-espera-v5 (27/10/2026) solo se acepta mientras dure la transición (ver
 * waitlistV5AcceptedUntil), con SUS reglas: teléfono obligatorio, sin campo de preferencia
 * (WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED si llega) y se guarda PHONE_AND_EMAIL, porque su
 * casilla consintió las llamadas. Nunca un alta v5 sin teléfono. Pasada la fecha, o si no se
 * configura, se rechaza como retirada (WAITLIST_POLICY_VERSION_RETIRED).
 *
 * Ninguna versión ofrece comunicaciones comerciales (commercialConsentRequested=true →
 * WAITLIST_COMMERCIAL_NOT_OFFERED).
 */
export const CURRENT_WAITLIST_PRIVACY_POLICY_VERSION = 'lista-espera-v6';
export const TRANSITIONAL_WAITLIST_PRIVACY_POLICY_VERSION = 'lista-espera-v5';
export const ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS = ['lista-espera-v5', 'lista-espera-v6'] as const;

/**
 * Versiones retiradas (condición 3 de Argos, 27/10/2026; retiradas cuando la landing publicada ya
 * enviaba la v5). Un alta NUEVA con ellas → 400 WAITLIST_POLICY_VERSION_RETIRED. Las filas ya
 * guardadas con estas versiones no cambian. Sus textos siguen archivados en
 * /privacidad-lista-espera/v1/ a /v4/ (y la v5 en /v5/ desde la publicación de la v6).
 *  - lista-espera-v1: 29/09/2026, Google Forms (nunca se aceptó en esta API).
 *  - lista-espera-v2: 16/10/2026 a 17/10/2026, con casilla opcional de comunicaciones comerciales.
 *  - lista-espera-v3: 17/10/2026 a 22/10/2026, sin comunicaciones comerciales.
 *  - lista-espera-v4: 22/10/2026 a 27/10/2026, panel web privado y aviso interno de altas.
 */
export const RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS = ['lista-espera-v1', 'lista-espera-v2', 'lista-espera-v3', 'lista-espera-v4'] as const;

/** Plazo máximo de la transición de la v5 (Lex Psi, §1.4: 7 días desde la publicación de la v6). */
export const WAITLIST_V5_TRANSITION_MAX_DAYS = 7;

/**
 * Fin de la transición de la v5: WAITLIST_V5_ACCEPTED_UNTIL (fecha ISO 8601 con zona, p. ej.
 * 2026-11-13T23:59:59+01:00). Sin la variable (o vacía) la v5 queda retirada: es el valor seguro.
 * Una fecha mal escrita o a más de 7 días del arranque impide arrancar (assertWaitlistConfig), para
 * que nadie alargue la transición por error.
 */
export function waitlistV5AcceptedUntil(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = env.WAITLIST_V5_ACCEPTED_UNTIL?.trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new InvalidWaitlistConfigError('WAITLIST_V5_ACCEPTED_UNTIL debe ser una fecha ISO 8601 con zona horaria (p. ej. 2026-11-13T23:59:59+01:00)');
  }
  const until = new Date(raw);
  if (Number.isNaN(until.getTime())) throw new InvalidWaitlistConfigError('WAITLIST_V5_ACCEPTED_UNTIL no es una fecha válida');
  return until;
}

function assertV5Transition(env: NodeJS.ProcessEnv, now: Date): void {
  const until = waitlistV5AcceptedUntil(env);
  if (until && until.getTime() > now.getTime() + WAITLIST_V5_TRANSITION_MAX_DAYS * 24 * 60 * 60_000) {
    throw new InvalidWaitlistConfigError(`WAITLIST_V5_ACCEPTED_UNTIL no puede estar a más de ${WAITLIST_V5_TRANSITION_MAX_DAYS} días (transición de la política lista-espera-v5)`);
  }
}

/**
 * ¿Se acepta hoy un alta NUEVA con esta versión? La v6 siempre; la v5 solo antes de
 * WAITLIST_V5_ACCEPTED_UNTIL; cualquier otra, nunca. Una variable mal escrita cuenta como «sin
 * transición» (nunca amplía lo aceptado).
 */
export function isWaitlistPolicyVersionAccepted(version: string, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (version === CURRENT_WAITLIST_PRIVACY_POLICY_VERSION) return true;
  if (version !== TRANSITIONAL_WAITLIST_PRIVACY_POLICY_VERSION) return false;
  let until: Date | null;
  try {
    until = waitlistV5AcceptedUntil(env);
  } catch {
    return false;
  }
  return until !== null && now.getTime() < until.getTime();
}

/** Tiempo mínimo entre pedir el token de formulario y enviarlo (un humano tarda más). */
export const WAITLIST_FORM_MIN_SECONDS = 3;
/** Caducidad del token de formulario. */
export const WAITLIST_FORM_MAX_AGE_SECONDS = 2 * 60 * 60;

/** Rate limit por IP (req.ip, que depende de TRUST_PROXY). Envíos: 5 cada 10 min (no cambia). */
export const WAITLIST_SUBMIT_THROTTLE = { default: { limit: 5, ttl: 10 * 60_000 } };
/**
 * Tokens de formulario: 80 cada 10 min por IP (Argos, 21/10/2026, arreglo de la landing). Emitir
 * un token es barato y sin estado (HMAC, sin BD ni cookies); el límite que protege es el de envíos.
 */
export const WAITLIST_TOKEN_THROTTLE = { default: { limit: 80, ttl: 10 * 60_000 } };

export class InvalidWaitlistConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWaitlistConfigError';
  }
}

export function parseWaitlistOrigins(raw: string | undefined, nodeEnv: string | undefined): string[] {
  const value = (raw ?? '').trim();
  if (!value) return [...DEFAULT_WAITLIST_ORIGINS];
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry === '')) {
    throw new InvalidWaitlistConfigError('WAITLIST_ALLOWED_ORIGINS contiene entradas vacías (comas sobrantes)');
  }
  return entries.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new InvalidWaitlistConfigError(`WAITLIST_ALLOWED_ORIGINS: "${entry}" no es un origen válido`);
    }
    if (entry === '*' || url.origin !== entry.replace(/\/$/, '')) {
      throw new InvalidWaitlistConfigError(`WAITLIST_ALLOWED_ORIGINS: "${entry}" debe ser solo esquema://host[:puerto], sin ruta ni comodines`);
    }
    if (url.protocol !== 'https:' && (nodeEnv === 'production' || url.protocol !== 'http:')) {
      throw new InvalidWaitlistConfigError(`WAITLIST_ALLOWED_ORIGINS: "${entry}" debe usar https (http solo fuera de producción)`);
    }
    return url.origin;
  });
}

export function waitlistAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseWaitlistOrigins(env.WAITLIST_ALLOWED_ORIGINS, env.NODE_ENV);
}

const DEV_SECRET = 'development-only-waitlist-secret-not-for-production';

function waitlistSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.WAITLIST_SECRET?.trim();
  if (!secret) {
    if (env.NODE_ENV === 'production') throw new InvalidWaitlistConfigError('WAITLIST_SECRET es obligatorio en producción');
    return DEV_SECRET;
  }
  if (secret.length < 32) throw new InvalidWaitlistConfigError('WAITLIST_SECRET debe tener al menos 32 caracteres');
  return secret;
}

/** Subclave independiente por propósito (no se reutiliza la misma clave para hash y firma). */
export function waitlistSubkey(purpose: 'email-hash-v1' | 'form-token-v1', env: NodeJS.ProcessEnv = process.env): Buffer {
  return createHmac('sha256', waitlistSecret(env)).update(`asepsico-waitlist:${purpose}`).digest();
}

/** Comprueba toda la configuración; se llama al arrancar para fallar pronto en producción. */
export function assertWaitlistConfig(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): void {
  waitlistAllowedOrigins(env);
  waitlistSubkey('email-hash-v1', env);
  assertV5Transition(env, now);
}
