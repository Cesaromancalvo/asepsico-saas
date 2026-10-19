import { UnauthorizedException } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service';

/** Código estable del 401 cuando el token está bien firmado pero la sesión ya no vale. */
export const SESSION_REVOKED = 'SESSION_REVOKED';

type SessionDb = Pick<PrismaService, 'workspaceMember' | 'user'>;
type TokenUser = { sub?: unknown; workspaceId?: unknown; tv?: unknown } | null | undefined;

function revoked(): never {
  throw new UnauthorizedException({ statusCode: 401, code: SESSION_REVOKED, message: 'Tu sesión ya no es válida. Vuelve a iniciar sesión.' });
}

/**
 * Revalidación del access token en CADA petición (historia B y pendiente de Argos del cambio de
 * contraseña). La firma y la caducidad no bastan: un token de 15 min sigue vivo tras una baja o
 * un cambio de contraseña. Se exige, contra la BD:
 *  1. membresía ACTIVE en el workspace del token (una baja corta el acceso al momento);
 *  2. `tv` del token igual a User.tokenVersion (el cambio de contraseña la sube).
 * Tokens emitidos antes de existir `tv` cuentan como versión 0: valen hasta su caducidad
 * (≤ 15 min) salvo que la versión ya haya subido.
 * Dos lecturas por clave única/índice en paralelo; falla cerrado (401) ante cualquier duda.
 */
export async function assertActiveSession(prisma: SessionDb, user: TokenUser): Promise<void> {
  if (!user || typeof user.sub !== 'string' || typeof user.workspaceId !== 'string') revoked();
  const tokenVersion = user.tv === undefined ? 0 : user.tv;
  if (typeof tokenVersion !== 'number' || !Number.isInteger(tokenVersion)) revoked();

  const [member, account] = await Promise.all([
    prisma.workspaceMember.findFirst({ where: { workspaceId: user.workspaceId, userId: user.sub, status: 'ACTIVE' }, select: { id: true } }),
    prisma.user.findUnique({ where: { id: user.sub }, select: { tokenVersion: true } }),
  ]);
  if (!member || !account) revoked();
  if ((account.tokenVersion ?? 0) !== tokenVersion) revoked();
}
