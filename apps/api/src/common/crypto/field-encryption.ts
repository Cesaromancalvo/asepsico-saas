import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Cifrado a nivel de campo para el contenido clínico narrativo más sensible
 * (ClinicalProcess.consultationReason/goals/internalNotes, Session.notes/internalSummary).
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
 * Formato de salida: "enc:v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>"
 * El prefijo "enc:v1:" permite distinguir un valor ya cifrado de uno en texto plano
 * antiguo (de antes de activar esto) — así la lectura de datos ya existentes en la base
 * de datos no revienta: si no lleva el prefijo, se devuelve tal cual, sin intentar
 * descifrarlo. Los valores viejos se cifran solos la próxima vez que se actualicen.
 */

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_LENGTH = 12; // recomendado para GCM

function getKey(): Buffer {
  const secret = process.env.FIELD_ENCRYPTION_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FIELD_ENCRYPTION_KEY es obligatorio en producción para cifrar contenido clínico');
    }
    // Clave de desarrollo fija y deliberadamente distinta de cualquier otro secreto del
    // proyecto — solo para que el entorno local funcione sin configuración extra.
    return scryptSync('development-only-field-encryption-key', 'asepsico-dev-salt', 32);
  }
  // Se admite la clave en base64 (recomendado, 32 bytes exactos) o se deriva de cualquier
  // texto con scrypt si no tiene la longitud exacta, para no bloquear a quien configure
  // esto por primera vez con una frase en vez de una clave generada.
  const asBase64 = Buffer.from(secret, 'base64');
  if (asBase64.length === 32) return asBase64;
  return scryptSync(secret, 'asepsico-field-encryption-salt', 32);
}

export function encryptField(plaintext: string | null | undefined): string | null | undefined {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptField(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined || value === '') return value;
  if (!value.startsWith(PREFIX)) return value; // valor antiguo sin cifrar, o ya en texto plano

  const [ivB64, authTagB64, ciphertextB64] = value.slice(PREFIX.length).split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) return value; // formato inesperado: no reventar, devolver tal cual

  try {
    const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    // Si la clave cambió o el dato está corrupto, preferimos avisar con un valor
    // reconocible antes que lanzar un error que tumbe toda la petición.
    return '[No se pudo descifrar este contenido]';
  }
}
