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

export async function verifyTotpCode(secret: string, token: string): Promise<boolean> {
  try {
    const result = await verify({ secret, token });
    return result.valid;
  } catch {
    return false;
  }
}

export async function generateTotpCodeForTesting(secret: string): Promise<string> {
  return generate({ secret });
}
