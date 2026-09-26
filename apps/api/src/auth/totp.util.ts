import { generateSecret, generateURI, generate, verify } from 'otplib';
import * as QRCode from 'qrcode';

export function generateTotpSecret(): string {
  return generateSecret();
}

export function getTotpUri(secret: string, email: string, issuer = 'AsePsico'): string {
  return generateURI({ issuer, label: email, secret });
}

export async function getTotpQrCodeDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri);
}

/**
 * Verifica un código TOTP y devuelve el paso de tiempo (floor(epoch / 30)) con el que
 * coincidió, o null si no es válido. Con la tolerancia por defecto de otplib (0) solo se
 * acepta el paso actual; si algún día se amplía la ventana, el paso devuelto sigue siendo
 * el que realmente coincidió (no el actual), que es el que hay que guardar para impedir
 * reutilizar el código (RFC 6238 §5.2).
 *
 * `afterTimeStep` rechaza ya en otplib cualquier paso igual o anterior al último usado;
 * aun así, quien llama debe reclamar el paso de forma atómica en la BD (dos peticiones
 * concurrentes pueden pasar ambas esta comprobación en memoria).
 */
export async function verifyTotpCode(secret: string, token: string, afterTimeStep?: number | null): Promise<number | null> {
  try {
    const result = await verify({
      secret,
      token,
      ...(typeof afterTimeStep === 'number' ? { afterTimeStep } : {}),
    });
    // Sin paso no hay forma de impedir la reutilización: se trata como no válido (fail closed).
    if (!result.valid || !('timeStep' in result) || typeof result.timeStep !== 'number') return null;
    return result.timeStep;
  } catch {
    return null;
  }
}

export async function generateTotpCodeForTesting(secret: string): Promise<string> {
  return generate({ secret });
}
