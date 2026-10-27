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
 *  - lista-espera-v4: 22/10/2026, acceso del responsable también desde un panel web privado, anotaciones
 *    de seguimiento y aviso interno de altas por Scaleway (texto de Lex Psi; pendiente de revisión del
 *    abogado humano). Mismas finalidades, bases y plazos que v3 y tampoco ofrece comunicaciones
 *    comerciales. La v3 queda archivada en /privacidad-lista-espera/v3/; se sigue aceptando solo durante
 *    la transición: retirarla cuando la landing publicada envíe lista-espera-v4.
 *  - lista-espera-v5: 27/10/2026, teléfono OBLIGATORIO (decisión del Jefe del 27/10). Texto de Lex Psi
 *    (borrador 1.0 del 27/10/2026; pendiente de revisión del abogado humano). Cambios sobre la v4:
 *    se trata el teléfono (guardado en formato internacional E.164); la finalidad pasa a ser
 *    contactar sobre el piloto «por email o por teléfono (llamada o SMS)», con la misma base jurídica
 *    (consentimiento, art. 6.1.a RGPD; el consentimiento previo cubre las llamadas, art. 66.1.b LGTel);
 *    el teléfono solo sirve para el piloto y la demo, no se cede ni se usa en grupos o listas de
 *    difusión; cada llamada empieza diciendo quién llama y por qué, y se puede pedir no recibir más
 *    llamadas: se borra SOLO el teléfono (waitlist:set-phone --clear o el panel) y se sigue por email;
 *    el aviso interno de altas no lleva el teléfono; mismos plazos máximos, más el borrado a los 14
 *    días tras un «no» al piloto. Sin comunicaciones comerciales. La v4 queda archivada en
 *    /privacidad-lista-espera/v4/.
 *
 * Regla del teléfono por versión (WaitlistService): con lista-espera-v5 es obligatorio
 * (WAITLIST_PHONE_REQUIRED / WAITLIST_PHONE_INVALID); con v2–v4 no se admite, porque su texto no lo
 * informa (WAITLIST_PHONE_NOT_INFORMED).
 *
 * Transición a la v5 (orden obligatorio, spec §12): (1) desplegar esta API, que acepta v5 con
 * teléfono y v2–v4 sin teléfono, así que la landing publicada (v4) sigue funcionando sin cambios;
 * (2) Lex publica la v5 y archiva la v4; (3) la landing envía lista-espera-v5 con phone;
 * (4) retirar v2, v3 y v4 de esta lista cuando la landing publicada ya envíe la v5.
 */
export const ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS = ['lista-espera-v2', 'lista-espera-v3', 'lista-espera-v4', 'lista-espera-v5'] as const;

/**
 * Versiones cuya política no ofrece comunicaciones comerciales: un alta con ellas y
 * commercialConsentRequested=true es un 400 (no se registra una solicitud que el texto aceptado no recoge).
 */
export const WAITLIST_POLICY_VERSIONS_WITHOUT_COMMERCIAL: readonly string[] = ['lista-espera-v3', 'lista-espera-v4', 'lista-espera-v5'];

/** Versiones cuya política informa del teléfono y lo exige. Con cualquier otra, enviar phone es un 400. */
export const WAITLIST_POLICY_VERSIONS_WITH_PHONE: readonly string[] = ['lista-espera-v5'];

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
