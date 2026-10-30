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
 * anterior (pasarla a RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS) cuando la landing ya no la sirva.
 *
 * Vigente: lista-espera-v5 (27/10/2026), con teléfono OBLIGATORIO (decisión del Jefe del 27/10).
 * Texto de Lex Psi (borrador 1.0 del 27/10/2026; pendiente de revisión del abogado humano): se trata
 * el teléfono (guardado en E.164); la finalidad es contactar sobre el piloto «por email o por
 * teléfono (llamada o SMS)», con base en el consentimiento (art. 6.1.a RGPD; cubre las llamadas,
 * art. 66.1.b LGTel); el teléfono solo sirve para el piloto y la demo, no se cede ni se usa en grupos
 * o listas de difusión; se puede pedir no recibir más llamadas: se borra SOLO el teléfono
 * (waitlist:set-phone --clear o el panel) y se sigue por email; el aviso interno de altas no lleva el
 * teléfono; borrado a los 14 días tras un «no» al piloto. Sin comunicaciones comerciales.
 *
 * Toda versión aceptada exige el teléfono (WAITLIST_PHONE_REQUIRED / WAITLIST_PHONE_INVALID) y no
 * ofrece comunicaciones comerciales (commercialConsentRequested=true → WAITLIST_COMMERCIAL_NOT_OFFERED).
 */
export const ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS = ['lista-espera-v5'] as const;

/**
 * Versiones retiradas (condición 3 de Argos, 27/10/2026; retiradas cuando la landing publicada ya
 * enviaba la v5). Un alta NUEVA con ellas → 400 WAITLIST_POLICY_VERSION_RETIRED. Las filas ya
 * guardadas con estas versiones no cambian. Sus textos siguen archivados en
 * /privacidad-lista-espera/v1/ a /v4/.
 *  - lista-espera-v1: 29/09/2026, Google Forms (nunca se aceptó en esta API).
 *  - lista-espera-v2: 16/10/2026 a 17/10/2026, con casilla opcional de comunicaciones comerciales.
 *  - lista-espera-v3: 17/10/2026 a 22/10/2026, sin comunicaciones comerciales.
 *  - lista-espera-v4: 22/10/2026 a 27/10/2026, panel web privado y aviso interno de altas.
 */
export const RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS = ['lista-espera-v1', 'lista-espera-v2', 'lista-espera-v3', 'lista-espera-v4'] as const;

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
export function assertWaitlistConfig(env: NodeJS.ProcessEnv = process.env): void {
  waitlistAllowedOrigins(env);
  waitlistSubkey('email-hash-v1', env);
}
