import { createHash, randomBytes } from 'crypto';

/** Genera un token opaco aleatorio (no es un JWT) para usar como refresh token. */
export function generateOpaqueToken(): string {
  return randomBytes(48).toString('base64url');
}

/** El refresh token nunca se guarda en claro en BD, solo su hash. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
