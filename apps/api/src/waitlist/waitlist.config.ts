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
 *  - WAITLIST_V5_ACCEPTED_UNTIL y WAITLIST_V6_ACCEPTED_UNTIL: RETIRADAS (la v5 y la v6 ya no se aceptan
 *    nunca). Si siguen puestas se IGNORAN, sea cual sea su valor: no amplían lo aceptado ni impiden
 *    arrancar; al arrancar solo se registra un aviso con el nombre de la variable (nunca su valor) para
 *    que se borre en Render (ver retiredWaitlistEnvVarsSet).
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
 * Sin transiciones abiertas: la v5 (transición hasta el 12/11/2026) y la v6 (hasta el 15/11/2026)
 * están retiradas desde el 16/11/2026. Para abrir otra transición al publicar una v8, recuperar el
 * mecanismo WAITLIST_POLICY_TRANSITIONS de la historia de git (variable con máx. 7 días y tope fijo).
 *
 * Ninguna versión ofrece comunicaciones comerciales (commercialConsentRequested=true →
 * WAITLIST_COMMERCIAL_NOT_OFFERED).
 */
export const CURRENT_WAITLIST_PRIVACY_POLICY_VERSION = 'lista-espera-v7';
export const ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS = ['lista-espera-v7'] as const;

/**
 * Versiones retiradas (condición 3 de Argos, 27/10/2026; retiradas cuando la landing publicada ya
 * enviaba la v5). Un alta NUEVA con ellas → 400 WAITLIST_POLICY_VERSION_RETIRED. Las filas ya
 * guardadas con estas versiones no cambian. Sus textos siguen archivados en
 * /privacidad-lista-espera/v1/ a /v6/.
 *  - lista-espera-v1: 29/09/2026, Google Forms (nunca se aceptó en esta API).
 *  - lista-espera-v2: 16/10/2026 a 17/10/2026, con casilla opcional de comunicaciones comerciales.
 *  - lista-espera-v3: 17/10/2026 a 22/10/2026, sin comunicaciones comerciales.
 *  - lista-espera-v4: 22/10/2026 a 27/10/2026, panel web privado y aviso interno de altas.
 *  - lista-espera-v5: 27/10/2026 a 12/11/2026 (con su transición), teléfono obligatorio.
 *  - lista-espera-v6: 03/11/2026 a 15/11/2026 (con su transición), preferencia de contacto.
 */
export const RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS = [
  'lista-espera-v1',
  'lista-espera-v2',
  'lista-espera-v3',
  'lista-espera-v4',
  'lista-espera-v5',
  'lista-espera-v6',
] as const;

/**
 * Variables de transición de versiones ya retiradas. Se ignoran (su valor no se interpreta ni se registra): solo
 * sirven para avisar al arrancar de que siguen puestas en el entorno y conviene borrarlas.
 */
export const RETIRED_WAITLIST_TRANSITION_ENV_VARS = ['WAITLIST_V5_ACCEPTED_UNTIL', 'WAITLIST_V6_ACCEPTED_UNTIL'] as const;

/** Nombres de las variables retiradas que siguen puestas (no vacías). Nunca devuelve sus valores. */
export function retiredWaitlistEnvVarsSet(env: NodeJS.ProcessEnv = process.env): string[] {
  return RETIRED_WAITLIST_TRANSITION_ENV_VARS.filter((name) => (env[name] ?? '').trim() !== '');
}

/**
 * ¿Se acepta un alta NUEVA con esta versión? Solo la vigente (v7). Cualquier otra, nunca: no depende
 * de la fecha ni de ninguna variable de entorno.
 */
export function isWaitlistPolicyVersionAccepted(version: string): boolean {
  return version === CURRENT_WAITLIST_PRIVACY_POLICY_VERSION;
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

/**
 * Comprueba toda la configuración; se llama al arrancar para fallar pronto en producción. Las variables
 * retiradas (RETIRED_WAITLIST_TRANSITION_ENV_VARS) no se comprueban: puestas o no, con cualquier valor,
 * nunca impiden arrancar.
 */
export function assertWaitlistConfig(env: NodeJS.ProcessEnv = process.env): void {
  waitlistAllowedOrigins(env);
  waitlistSubkey('email-hash-v1', env);
}
