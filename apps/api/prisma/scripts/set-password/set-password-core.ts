import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { normalizeEmail } from '../../../src/auth/invite-token.util';

/**
 * Lógica del CLI `users:set-password` (sin E/S de terminal, para poder probarla).
 *
 * - Mismo hash que el alta y el login: bcrypt (bcryptjs) con coste 12 (registration.service.ts).
 * - En la MISMA transacción: cambia el hash, revoca TODOS los RefreshToken activos del usuario y
 *   deja un AuditLog `USER_PASSWORD_RESET_CLI` por cada workspace del que es miembro.
 * - La auditoría no lleva datos personales: ni correo, ni nombre, ni IP, ni la contraseña; solo el
 *   id del usuario (entityId) y el número de sesiones revocadas.
 * - Todas las consultas usan `select` mínimo: funciona igual con el esquema de 27 migraciones que
 *   con el de 30 (no lee columnas nuevas como `isDemo`).
 */
export const PASSWORD_RESET_CLI_ACTION = 'USER_PASSWORD_RESET_CLI';
export const MIN_CLI_PASSWORD_LENGTH = 14;
/** bcrypt solo usa los primeros 72 bytes: más allá daría una falsa sensación de seguridad. */
export const MAX_CLI_PASSWORD_BYTES = 72;
export const CLI_BCRYPT_COST = 12;

export class SetPasswordError extends Error {}

/** Devuelve el motivo del rechazo, o null si la contraseña vale. Nunca incluye la contraseña. */
export function validateNewPassword(first: string, second: string): string | null {
  if (first !== second) return 'Las dos contraseñas no coinciden.';
  if ([...first].length < MIN_CLI_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_CLI_PASSWORD_LENGTH} caracteres.`;
  if (Buffer.byteLength(first, 'utf8') > MAX_CLI_PASSWORD_BYTES) return `La contraseña no puede pasar de ${MAX_CLI_PASSWORD_BYTES} bytes (límite de bcrypt).`;
  if (first.trim() !== first) return 'La contraseña no puede empezar ni terminar con espacios.';
  if (/[\u0000-\u001f\u007f]/.test(first)) return 'La contraseña no puede contener caracteres de control.';
  return null;
}

export function isValidEmailArg(email: string | undefined): email is string {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export type SetPasswordResult = { userId: string; revokedSessions: number; auditedWorkspaces: number };

export async function setUserPassword(
  prisma: PrismaClient,
  input: { email: string; password: string; now?: Date },
): Promise<SetPasswordResult> {
  const email = normalizeEmail(input.email);
  // Mensaje genérico: no confirma si el correo existe más allá de lo imprescindible para el operador.
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new SetPasswordError('No hay ninguna cuenta de profesional con ese correo. No se ha cambiado nada.');

  const memberships = await prisma.workspaceMember.findMany({ where: { userId: user.id }, select: { workspaceId: true } });
  const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))];
  // AuditLog exige workspaceId: sin espacio no hay dónde auditar, y sin espacio la cuenta tampoco
  // puede entrar (login exige una membresía). Se rechaza en vez de cambiar sin rastro.
  if (workspaceIds.length === 0) throw new SetPasswordError('La cuenta no pertenece a ningún espacio: no se puede auditar el cambio. No se ha cambiado nada.');

  const passwordHash = await hash(input.password, CLI_BCRYPT_COST);
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash }, select: { id: true } });
    const revoked = await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
    await tx.auditLog.createMany({
      data: workspaceIds.map((workspaceId) => ({
        workspaceId,
        actorId: null, // lo ejecuta el operador de la plataforma, no el usuario
        action: PASSWORD_RESET_CLI_ACTION,
        entityType: 'User',
        entityId: user.id,
        metadata: { via: 'cli', revokedSessions: revoked.count },
      })),
    });
    return { userId: user.id, revokedSessions: revoked.count, auditedWorkspaces: workspaceIds.length };
  });
}
