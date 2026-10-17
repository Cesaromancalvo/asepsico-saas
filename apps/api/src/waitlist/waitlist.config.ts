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
 */

export const WAITLIST_PATH = '/api/v1/public/waitlist';

export const DEFAULT_WAITLIST_ORIGINS = ['https://asepsico.es', 'https://www.asepsico.es'];

/**
 * Versiones de la política de privacidad de la lista de espera que la API acepta. La landing
 * envía la versión que ha mostrado y se guarda tal cual. Al publicar una política nueva: añadir
 * su versión aquí (y en packages/contracts), desplegar la API y DESPUÉS la landing; retirar la
 * anterior cuando la landing ya no la sirva.
 *  - lista-espera-v1: texto del 29/09/2026 (Google Forms). No se acepta: no describe este formulario.
 *  - lista-espera-v2: formulario propio en asepsico.es (texto de Lex Psi; pendiente de revisión del abogado humano).
 *    Altas del 16/10/2026 al 17/10/2026. Se sigue aceptando solo durante la transición a v3: retirarla
 *    cuando la landing publicada envíe lista-espera-v3. Los registros ya guardados con v2 no cambian.
 *  - lista-espera-v3: 17/10/2026, sin casilla de comunicaciones comerciales y con "¿Qué usas hoy?" en
 *    opciones (texto de Lex Psi; pendiente de revisión del abogado humano). La v2 queda archivada
 *    en /privacidad-lista-espera/v2/.
 */
export const ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS = ['lista-espera-v2', 'lista-espera-v3'] as const;

/**
 * Versiones cuya política no ofrece comunicaciones comerciales: un alta con ellas y
 * commercialConsentRequested=true es un 400 (no se registra una solicitud que el texto aceptado no recoge).
 */
export const WAITLIST_POLICY_VERSIONS_WITHOUT_COMMERCIAL: readonly string[] = ['lista-espera-v3'];

/** Tiempo mínimo entre pedir el token de formulario y enviarlo (un humano tarda más). */
export const WAITLIST_FORM_MIN_SECONDS = 3;
/** Caducidad del token de formulario. */
export const WAITLIST_FORM_MAX_AGE_SECONDS = 2 * 60 * 60;

/** Rate limit por IP (req.ip, que depende de TRUST_PROXY). */
export const WAITLIST_SUBMIT_THROTTLE = { default: { limit: 5, ttl: 10 * 60_000 } };
export const WAITLIST_TOKEN_THROTTLE = { default: { limit: 20, ttl: 10 * 60_000 } };

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
export function assertWaitlistConfig(env: NodeJS.ProcessEnv = process.env): void {
  waitlistAllowedOrigins(env);
  waitlistSubkey('email-hash-v1', env);
}
