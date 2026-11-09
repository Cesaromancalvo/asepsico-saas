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
 *    7 días y nunca después del 12/11/2026 a las 23:59:59 hora peninsular; ver
 *    waitlistTransitionUntil). Sin ella, la v5 está retirada.
 *  - WAITLIST_V6_ACCEPTED_UNTIL: fin de la transición de la política lista-espera-v6 tras publicar la
 *    v7 (opcional, máx. 7 días). Sin ella, la v6 está retirada.
 */

export const WAITLIST_PATH = '/api/v1/public/waitlist';

export const DEFAULT_WAITLIST_ORIGINS = ['https://asepsico.es', 'https://www.asepsico.es'];

/**
 * Versiones de la política de privacidad de la lista de espera que la API acepta. La landing
 * envía la versión que ha mostrado y se guarda tal cual. Al publicar una política nueva: añadir
 * su versión aquí (y en packages/contracts), desplegar la API y DESPUÉS la landing; retirar la
 * anterior (pasarla a RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS) cuando acabe su transición.
 *
 * Vigente: lista-espera-v7 (decisión del Jefe del 09/11/2026; texto de Lex Psi en redacción,
 * pendiente del abogado humano). Teléfono OBLIGATORIO, como en la v5, y SIN campo de preferencia:
 *  - Teléfono obligatorio (WAITLIST_PHONE_REQUIRED / WAITLIST_PHONE_INVALID), en E.164 y cifrado.
 *  - contactPreference no se ofrece: si llega → WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED. Se guarda
 *    PHONE_AND_EMAIL (la única coherente con un teléfono obligatorio y con el invariante
 *    «PHONE_AND_EMAIL ⇔ teléfono» de las filas activas; el texto de la v7 debe informar de las
 *    llamadas, art. 66.1.b LGTel).
 *
 * Transiciones (WAITLIST_POLICY_TRANSITIONS): cada versión anterior solo se acepta, con SUS reglas,
 * mientras lo diga su variable (máx. 7 días desde el arranque; sin variable o mal escrita, retirada):
 *  - lista-espera-v6 (03/11/2026): preferencia obligatoria y sin valor por defecto; PHONE_AND_EMAIL
 *    exige teléfono y EMAIL_ONLY lo prohíbe (WAITLIST_PHONE_NOT_ALLOWED; minimización, art. 5.1.c).
 *    Sin preferencia → WAITLIST_CONTACT_PREFERENCE_REQUIRED.
 *  - lista-espera-v5 (27/10/2026): teléfono obligatorio y sin preferencia (se guarda PHONE_AND_EMAIL).
 *    Además, tope fijo en el código (hardEnd): nunca se acepta después del 12/11/2026, aunque la
 *    variable diga otra cosa (un reinicio con la variable movida no alarga la transición).
 * Pasada la fecha → WAITLIST_POLICY_VERSION_RETIRED.
 *
 * Ninguna versión ofrece comunicaciones comerciales (commercialConsentRequested=true →
 * WAITLIST_COMMERCIAL_NOT_OFFERED).
 */
export const CURRENT_WAITLIST_PRIVACY_POLICY_VERSION = 'lista-espera-v7';
export const ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS = ['lista-espera-v5', 'lista-espera-v6', 'lista-espera-v7'] as const;

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

/** Plazo máximo de cualquier transición (Lex Psi, §1.4: 7 días desde la publicación de la nueva). */
export const WAITLIST_TRANSITION_MAX_DAYS = 7;
/** @deprecated Alias de WAITLIST_TRANSITION_MAX_DAYS (mismo plazo para la v5 y la v6). */
export const WAITLIST_V5_TRANSITION_MAX_DAYS = WAITLIST_TRANSITION_MAX_DAYS;

export type TransitionalWaitlistPolicyVersion = 'lista-espera-v5' | 'lista-espera-v6';

interface WaitlistPolicyTransition {
  /** Variable de entorno con el fin de la transición (ISO 8601 con zona). */
  envVar: 'WAITLIST_V5_ACCEPTED_UNTIL' | 'WAITLIST_V6_ACCEPTED_UNTIL';
  /** Tope fijo: a partir de aquí la versión nunca se acepta, diga lo que diga la variable. */
  hardEnd: Date | null;
}

/** Versiones en transición. Al acabar una: quitarla de aquí y pasarla a RETIRED_…. */
export const WAITLIST_POLICY_TRANSITIONS: Readonly<Record<TransitionalWaitlistPolicyVersion, WaitlistPolicyTransition>> = {
  // Fijada en producción hasta el 12/11/2026 a las 23:59 (hora peninsular) al publicar la v6.
  'lista-espera-v5': { envVar: 'WAITLIST_V5_ACCEPTED_UNTIL', hardEnd: new Date('2026-11-12T23:59:59+01:00') },
  // Se abre al publicar la v7 (fecha de publicación + 7 días como máximo).
  'lista-espera-v6': { envVar: 'WAITLIST_V6_ACCEPTED_UNTIL', hardEnd: null },
};

export function isTransitionalWaitlistPolicyVersion(version: string): version is TransitionalWaitlistPolicyVersion {
  return Object.prototype.hasOwnProperty.call(WAITLIST_POLICY_TRANSITIONS, version);
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Fin de la transición de una versión, tal como lo dice su variable (p. ej.
 * WAITLIST_V6_ACCEPTED_UNTIL=2026-11-17T23:59:59+01:00). Sin la variable (o vacía) → null: la versión
 * queda retirada, que es el valor seguro. Una fecha mal escrita lanza InvalidWaitlistConfigError (al
 * arrancar, assertWaitlistConfig impide que la API se levante). No aplica el tope fijo (hardEnd).
 */
export function waitlistTransitionUntil(version: TransitionalWaitlistPolicyVersion, env: NodeJS.ProcessEnv = process.env): Date | null {
  const { envVar } = WAITLIST_POLICY_TRANSITIONS[version];
  const raw = env[envVar]?.trim();
  if (!raw) return null;
  if (!ISO_WITH_ZONE.test(raw)) {
    throw new InvalidWaitlistConfigError(`${envVar} debe ser una fecha ISO 8601 con zona horaria (p. ej. 2026-11-13T23:59:59+01:00)`);
  }
  const until = new Date(raw);
  if (Number.isNaN(until.getTime())) throw new InvalidWaitlistConfigError(`${envVar} no es una fecha válida`);
  return until;
}

/** Fin de la transición de la v5 (WAITLIST_V5_ACCEPTED_UNTIL). */
export function waitlistV5AcceptedUntil(env: NodeJS.ProcessEnv = process.env): Date | null {
  return waitlistTransitionUntil('lista-espera-v5', env);
}

/** Fin de la transición de la v6 (WAITLIST_V6_ACCEPTED_UNTIL). */
export function waitlistV6AcceptedUntil(env: NodeJS.ProcessEnv = process.env): Date | null {
  return waitlistTransitionUntil('lista-espera-v6', env);
}

/**
 * Cada variable de transición: bien escrita y a 7 días como máximo del arranque (para que nadie alargue
 * una transición por error). Una fecha ya pasada es válida (la versión queda retirada): así la
 * variable de la v5 puede seguir puesta tras el 12/11 sin impedir el arranque.
 */
function assertTransitions(env: NodeJS.ProcessEnv, now: Date): void {
  for (const version of Object.keys(WAITLIST_POLICY_TRANSITIONS) as TransitionalWaitlistPolicyVersion[]) {
    const until = waitlistTransitionUntil(version, env);
    if (until && until.getTime() > now.getTime() + WAITLIST_TRANSITION_MAX_DAYS * 24 * 60 * 60_000) {
      const { envVar } = WAITLIST_POLICY_TRANSITIONS[version];
      throw new InvalidWaitlistConfigError(`${envVar} no puede estar a más de ${WAITLIST_TRANSITION_MAX_DAYS} días (transición de la política ${version})`);
    }
  }
}

/**
 * ¿Se acepta hoy un alta NUEVA con esta versión? La vigente (v7) siempre; una en transición solo
 * antes del fin que diga su variable y, si lo tiene, antes de su tope fijo; cualquier otra, nunca.
 * Una variable mal escrita cuenta como «sin transición» (nunca amplía lo aceptado).
 */
export function isWaitlistPolicyVersionAccepted(version: string, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (version === CURRENT_WAITLIST_PRIVACY_POLICY_VERSION) return true;
  if (!isTransitionalWaitlistPolicyVersion(version)) return false;
  let until: Date | null;
  try {
    until = waitlistTransitionUntil(version, env);
  } catch {
    return false;
  }
  if (until === null || now.getTime() >= until.getTime()) return false;
  const { hardEnd } = WAITLIST_POLICY_TRANSITIONS[version];
  return hardEnd === null || now.getTime() < hardEnd.getTime();
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
  assertTransitions(env, now);
}
