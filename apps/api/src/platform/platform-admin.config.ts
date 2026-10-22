import { normalizeEmail } from '../auth/invite-token.util';
import type { PrismaService } from '../database/prisma.service';

/**
 * Capacidad de plataforma PLATFORM_ADMIN (panel privado de la lista de espera).
 *
 * NO es un WorkspaceRole ni se guarda en base de datos: se asigna SOLO con la variable de entorno
 * de la API PLATFORM_ADMIN_EMAILS (emails separados por comas). Sin la variable, o vacía, nadie es
 * PLATFORM_ADMIN (falla cerrado). Cambiarla exige redesplegar. No existe endpoint, pantalla, DTO
 * ni seed que la conceda o la modifique.
 *
 * Requisitos acumulativos (isPlatformAdmin):
 *  1. sesión normal válida (JwtAuthGuard: firma, caducidad, membresía ACTIVE, tokenVersion, condiciones);
 *  2. el access token dice mfaEnabled=true (la sesión se abrió con el segundo factor activo);
 *  3. en la BD la cuenta tiene totpEnabled=true (si se desactiva el MFA, se pierde el acceso al momento);
 *  4. el email de la cuenta (el de la BD, no el del token), ASCII imprimible, está tal cual en
 *     PLATFORM_ADMIN_EMAILS (normalizada como se guardan las cuentas: trim + minúsculas).
 *
 * No concede nada sobre workspaces ni datos clínicos: el workspaceId y el rol del token siguen
 * funcionando exactamente igual que para cualquier usuario.
 */

/**
 * Veto de Argos (ALTA): se compara con la MISMA normalización con la que se guardan los emails de
 * las cuentas (invite-token.util.ts → normalizeEmail: trim + toLowerCase, sin NFKC) y por igualdad
 * EXACTA con User.email. Con NFKC, una cuenta registrada como «ａdmin@…» (ancho completo) o con la
 * ligadura «ﬁ» se habría "normalizado" al email del admin sin chocar con el @unique de la BD.
 * Además, tanto las entradas de la variable como el email de la cuenta deben ser ASCII imprimible:
 * cualquier otro carácter → no es admin.
 */
export const PRINTABLE_ASCII_EMAIL = /^[\x21-\x7e]+@[\x21-\x7e]+$/;

export function isPrintableAsciiEmail(email: string): boolean {
  return PRINTABLE_ASCII_EMAIL.test(email);
}

/** Entradas vacías, sin "@" o con caracteres fuera de ASCII imprimible se ignoran (nunca amplían el acceso). */
export function parsePlatformAdminEmails(raw: string | undefined): ReadonlySet<string> {
  const emails = (raw ?? '')
    .split(',')
    .map(normalizeEmail)
    .filter((email) => email.length > 0 && isPrintableAsciiEmail(email));
  return new Set(emails);
}

/** Se lee en cada petición: no hay estado en memoria que pueda quedarse desfasado. */
export function platformAdminEmails(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return parsePlatformAdminEmails(env.PLATFORM_ADMIN_EMAILS);
}

type TokenUser = { sub?: unknown; mfaEnabled?: unknown } | null | undefined;

export async function isPlatformAdmin(
  prisma: Pick<PrismaService, 'user'>,
  user: TokenUser,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const allowed = platformAdminEmails(env);
  if (allowed.size === 0) return false;
  if (!user || typeof user.sub !== 'string' || user.mfaEnabled !== true) return false;
  const account = await prisma.user.findUnique({ where: { id: user.sub }, select: { email: true, totpEnabled: true } });
  if (!account || account.totpEnabled !== true) return false;
  // Igualdad exacta con el email tal y como está guardado (ya normalizado al registrarse).
  if (typeof account.email !== 'string' || !isPrintableAsciiEmail(account.email)) return false;
  return allowed.has(account.email);
}
