import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Cifrado a nivel de campo, con soporte de rotación de clave por versión.
 *
 * Formato de salida: "enc:v<N>:<iv-base64>:<authTag-base64>:<ciphertext-base64>"
 * El número de versión en el propio texto cifrado indica con qué clave se cifró.
 *
 * Configuración por variables de entorno:
 *   FIELD_ENCRYPTION_KEY        → clave de la versión 1 (la que ya existe hoy, sin tocar)
 *   FIELD_ENCRYPTION_KEY_V2, V3, ...  → claves de versiones futuras, cuando toque rotar
 *   FIELD_ENCRYPTION_ACTIVE_VERSION   → qué versión se usa para CIFRAR datos nuevos (por defecto 1)
 *
 * Rotar la clave, el día que haga falta, es: añadir FIELD_ENCRYPTION_KEY_V2, subir
 * FIELD_ENCRYPTION_ACTIVE_VERSION a 2, y desplegar. Los datos viejos (v1) se siguen
 * leyendo bien mientras FIELD_ENCRYPTION_KEY siga configurada; los nuevos ya se cifran
 * con v2. Una migración aparte puede re-cifrar los datos viejos a v2 con calma, sin prisa.
 */

const ALGORITHM = 'aes-256-gcm';
const PREFIX_RE = /^enc:v(\d+):(.+)$/;
const IV_LENGTH = 12;

function keyEnvVarName(version: number): string {
  return version === 1 ? 'FIELD_ENCRYPTION_KEY' : `FIELD_ENCRYPTION_KEY_V${version}`;
}

function deriveKey(secret: string, version: number): Buffer {
  const asBase64 = Buffer.from(secret, 'base64');
  if (asBase64.length === 32) return asBase64;
  // Sal distinta por versión: aunque alguien reutilizara sin querer el mismo texto como
  // clave de dos versiones, las claves derivadas resultantes no coincidirían.
  return scryptSync(secret, `asepsico-field-encryption-salt-v${version}`, 32);
}

function getKeyForVersion(version: number): Buffer {
  const envVar = keyEnvVarName(version);
  const secret = process.env[envVar];
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`${envVar} es obligatorio en producción para leer/escribir contenido cifrado en versión ${version}`);
    }
    return scryptSync(`development-only-key-v${version}`, `asepsico-dev-salt-v${version}`, 32);
  }
  return deriveKey(secret, version);
}

function getActiveVersion(): number {
  const raw = process.env.FIELD_ENCRYPTION_ACTIVE_VERSION;
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function encryptField(plaintext: string | null | undefined): string | null | undefined {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const version = getActiveVersion();
  const key = getKeyForVersion(version);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:v${version}:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptField(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined || value === '') return value;
  const match = value.match(PREFIX_RE);
  if (!match) return value; // valor sin cifrar (dato antiguo de antes de activar esto)

  const version = Number.parseInt(match[1], 10);
  const [ivB64, authTagB64, ciphertextB64] = match[2].split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) return value;

  try {
    const key = getKeyForVersion(version);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    return '[No se pudo descifrar este contenido]';
  }
}

/** Para comprobaciones/migraciones: con qué versión de clave está cifrado un valor, o null si no está cifrado. */
export function getEncryptionVersion(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(PREFIX_RE);
  return match ? Number.parseInt(match[1], 10) : null;
}
