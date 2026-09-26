import { UnprocessableEntityException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Cifrado a nivel de campo para el contenido clínico narrativo. La lista de campos cifrados
 * vive en un único sitio: common/crypto/encrypted-fields.ts (la usan los servicios, la
 * exportación, el script de migración y los tests).
 *
 * Por qué esto y no cifrar toda la base de datos: el control de acceso por rol ya protege
 * estos campos frente a quien use la API sin permiso. Esto añade una capa distinta —
 * protege frente a quien accediera directamente a la base de datos saltándose la API por
 * completo (una brecha en el proveedor de hosting, un backup robado, un volcado de disco).
 *
 * AES-256-GCM: cifrado autenticado (si alguien manipula el texto cifrado, el descifrado
 * falla en vez de devolver datos corruptos en silencio). Cada valor lleva su propio IV
 * aleatorio, así que dos pacientes con el mismo texto no producen el mismo cifrado.
 *
 * Formatos:
 *  - v1 (histórico): "enc:v1:<iv>:<authTag>:<ciphertext>" con la clave única FIELD_ENCRYPTION_KEY.
 *  - v2 (rotación):  "enc:v2:<kid>:<iv>:<authTag>:<ciphertext>" con la clave <kid> del llavero
 *    FIELD_ENCRYPTION_KEYS ("kid1:clave1,kid2:clave2"); se escribe siempre con la clave
 *    FIELD_ENCRYPTION_ACTIVE_KID y se lee con la que indique el propio valor.
 *
 * Compatibilidad: si FIELD_ENCRYPTION_KEYS no está configurado, se sigue escribiendo v1 con
 * FIELD_ENCRYPTION_KEY exactamente como antes. Los valores v1 se siguen leyendo siempre con
 * FIELD_ENCRYPTION_KEY (hay que mantenerla mientras quede algún v1; el script
 * prisma/scripts/encrypt-plaintext-fields.ts --rotate los reescribe con la clave activa).
 *
 * Un valor sin prefijo "enc:" se devuelve tal cual (dato antiguo en claro, de antes de
 * activar el cifrado): el script de migración los cifra.
 */

const ALGORITHM = 'aes-256-gcm';
const PREFIX_V1 = 'enc:v1:';
const PREFIX_V2 = 'enc:v2:';
const IV_LENGTH = 12; // recomendado para GCM
const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const DECRYPTION_FAILED_PLACEHOLDER = '[No se pudo descifrar este contenido]';

const derivedKeyCache = new Map<string, Buffer>();

function deriveKey(secret: string, salt: string): Buffer {
  // Se admite la clave en base64 (recomendado, 32 bytes exactos) o se deriva de cualquier
  // texto con scrypt si no tiene la longitud exacta, para no bloquear a quien configure
  // esto por primera vez con una frase en vez de una clave generada.
  const cacheKey = `${salt}\u0000${secret}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  const asBase64 = Buffer.from(secret, 'base64');
  const key = asBase64.length === 32 ? asBase64 : scryptSync(secret, salt, 32);
  derivedKeyCache.set(cacheKey, key);
  return key;
}

/** Clave de los valores v1 (y de escritura cuando no hay llavero configurado). */
function getLegacyKey(): Buffer {
  const secret = process.env.FIELD_ENCRYPTION_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FIELD_ENCRYPTION_KEY es obligatorio en producción para cifrar contenido clínico');
    }
    // Clave de desarrollo fija y deliberadamente distinta de cualquier otro secreto del
    // proyecto — solo para que el entorno local funcione sin configuración extra.
    return deriveKey('development-only-field-encryption-key', 'asepsico-dev-salt');
  }
  return deriveKey(secret, 'asepsico-field-encryption-salt');
}

interface Keyring { activeKid: string; keys: Map<string, Buffer> }

/**
 * Llavero de rotación. Devuelve null si FIELD_ENCRYPTION_KEYS no está configurado (modo v1).
 * Una configuración incompleta o mal formada lanza siempre: es preferible no arrancar/cifrar a
 * escribir con una clave distinta de la esperada.
 */
function getKeyring(): Keyring | null {
  const raw = process.env.FIELD_ENCRYPTION_KEYS?.trim();
  if (!raw) return null;
  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    const kid = sep > 0 ? entry.slice(0, sep) : '';
    const secret = sep > 0 ? entry.slice(sep + 1) : '';
    if (!KID_PATTERN.test(kid) || !secret) {
      throw new Error('FIELD_ENCRYPTION_KEYS mal formado: se espera "kid:clave,kid2:clave2" (kid alfanumérico, _ o -)');
    }
    if (keys.has(kid)) throw new Error(`FIELD_ENCRYPTION_KEYS contiene el kid "${kid}" repetido`);
    keys.set(kid, deriveKey(secret, 'asepsico-field-encryption-salt'));
  }
  const activeKid = process.env.FIELD_ENCRYPTION_ACTIVE_KID?.trim();
  if (!activeKid || !keys.has(activeKid)) {
    throw new Error('FIELD_ENCRYPTION_ACTIVE_KID debe indicar una de las claves de FIELD_ENCRYPTION_KEYS');
  }
  return { activeKid, keys };
}

/** Kid con el que se escribe ahora mismo ("v1" si no hay llavero). */
export function activeEncryptionKid(): string {
  return getKeyring()?.activeKid ?? 'v1';
}

/** true si el valor lleva un prefijo de cifrado reconocido (v1 o v2). */
export function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && (value.startsWith(PREFIX_V1) || value.startsWith(PREFIX_V2));
}

/** Kid del valor cifrado ("v1" para el formato histórico), o null si no está cifrado. */
export function encryptedValueKid(value: string): string | null {
  if (value.startsWith(PREFIX_V1)) return 'v1';
  if (value.startsWith(PREFIX_V2)) return value.slice(PREFIX_V2.length).split(':')[0] || null;
  return null;
}

function seal(key: Buffer, plaintext: string) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

function open(key: Buffer, ivB64: string, authTagB64: string, ciphertextB64: string): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Se lanza si alguien intenta guardar el marcador de "no se pudo descifrar": significaría
 * persistir el marcador ENCIMA del dato original (que quizá solo es ilegible por una clave mal
 * configurada) y perderlo para siempre. Es un 422 para la API; el script lo trata como error.
 */
export class DecryptionPlaceholderWriteError extends UnprocessableEntityException {
  constructor() {
    super('Este contenido no se pudo descifrar y no se puede guardar tal cual. Avisa al administrador antes de editarlo.');
  }
}

export function encryptField(plaintext: string | null | undefined): string | null | undefined {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (plaintext.trim() === DECRYPTION_FAILED_PLACEHOLDER) throw new DecryptionPlaceholderWriteError();
  const keyring = getKeyring();
  if (keyring) return `${PREFIX_V2}${keyring.activeKid}:${seal(keyring.keys.get(keyring.activeKid)!, plaintext)}`;
  return `${PREFIX_V1}${seal(getLegacyKey(), plaintext)}`;
}

/**
 * Descifrado estricto: lanza si el valor está cifrado pero no se puede descifrar (clave
 * ausente, kid desconocido, dato manipulado). Lo usa el script de migración/rotación, que
 * nunca debe sobrescribir un valor que no ha podido leer.
 */
export function decryptFieldStrict(value: string): string {
  if (value.startsWith(PREFIX_V1)) {
    const [iv, tag, ct] = value.slice(PREFIX_V1.length).split(':');
    if (!iv || !tag || !ct) throw new Error('Valor enc:v1 con formato inesperado');
    return open(getLegacyKey(), iv, tag, ct);
  }
  if (value.startsWith(PREFIX_V2)) {
    const [kid, iv, tag, ct] = value.slice(PREFIX_V2.length).split(':');
    if (!kid || !iv || !tag || !ct) throw new Error('Valor enc:v2 con formato inesperado');
    const key = getKeyring()?.keys.get(kid);
    if (!key) throw new Error(`No hay clave configurada para el kid "${kid}"`);
    return open(key, iv, tag, ct);
  }
  return value;
}

export function decryptField(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined || value === '') return value;
  if (!isEncryptedValue(value)) return value; // valor antiguo sin cifrar, o ya en texto plano
  try {
    return decryptFieldStrict(value);
  } catch {
    // Si la clave cambió o el dato está corrupto, preferimos avisar con un valor
    // reconocible antes que lanzar un error que tumbe toda la petición.
    return DECRYPTION_FAILED_PLACEHOLDER;
  }
}
