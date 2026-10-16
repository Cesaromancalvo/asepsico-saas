import { randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { hashToken } from './token.util';

/** Caducidad de cualquier invitación (registro de workspace nuevo o miembro). */
export const INVITE_TTL_DAYS = 14;
export const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Token opaco de 256 bits. Solo se muestra una vez; en la BD se guarda su SHA-256. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return hashToken(token);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Enlace que abre la web. El token va en el fragmento (#), que el navegador nunca envía al
 * servidor: no queda en logs de acceso, proxies ni cabeceras Referer.
 */
export function buildInviteUrl(path: '/register' | '/join', token: string, webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000') {
  return `${webOrigin.replace(/\/+$/, '')}${path}#invite=${token}`;
}

/**
 * Crea una invitación de registro (workspace nuevo). Solo la usan el CLI de plataforma y el seed:
 * no hay ningún endpoint que la exponga. Revoca las invitaciones pendientes al mismo correo.
 */
export async function createRegistrationInvite(prisma: PrismaClient, input: { email: string; createdBy: string; now?: Date }) {
  const email = normalizeEmail(input.email);
  const now = input.now ?? new Date();
  const token = generateInviteToken();
  const invite = await prisma.$transaction(async (tx) => {
    await tx.registrationInvite.updateMany({
      where: { email, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    return tx.registrationInvite.create({
      data: { email, tokenHash: hashInviteToken(token), expiresAt: new Date(now.getTime() + INVITE_TTL_MS), createdBy: input.createdBy },
      select: { id: true, email: true, expiresAt: true },
    });
  });
  return { token, invite };
}
