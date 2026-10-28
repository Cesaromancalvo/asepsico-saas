import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { normalizeEmail } from '../../../src/auth/invite-token.util';
import { isLocalDatabaseUrl } from '../waitlist-script-utils';

/**
 * Lógica del CLI `users:set-password` (sin E/S de terminal, para poder probarla).
 *
 * Dos usos, ambos auditados:
 *  1. Rotar las cuentas ficticias del espacio demo (Recepción Demo, Terapeuta Demo). Es el modo por
 *     defecto: solo acepta cuentas con `User.isDemo = true`.
 *  2. Restablecer el acceso de una profesional del piloto que perdió la contraseña o el MFA (manual
 *     de onboarding §3.7, condición de Argos 28/10). Exige `--allow-non-demo`, el correo por prompt
 *     (nunca en el historial de la shell) y confirmar que se verificó la identidad.
 *
 * - Mismo hash que el alta y el login: bcrypt (bcryptjs) con coste 12 (registration.service.ts).
 * - En la MISMA transacción: nuevo hash, sube `tokenVersion` (compare-and-set: los access tokens vivos
 *   dejan de valer al momento), `passwordChangedAt`, pone a cero `mfaFailedAttempts`/`mfaLockedUntil`,
 *   con `--reset-mfa` borra el TOTP y los códigos de recuperación, revoca TODOS los RefreshToken del
 *   usuario y deja un AuditLog `USER_PASSWORD_RESET_CLI` (y `USER_MFA_RESET_CLI` si procede) en cada
 *   espacio donde la membresía está ACTIVE.
 * - La auditoría no lleva datos personales ni secretos: ni correo, ni nombre, ni IP, ni contraseña,
 *   ni hash, ni secreto TOTP; solo el id del usuario (entityId) y contadores/flags.
 */
export const PASSWORD_RESET_CLI_ACTION = 'USER_PASSWORD_RESET_CLI';
export const MFA_RESET_CLI_ACTION = 'USER_MFA_RESET_CLI';
export const MIN_CLI_PASSWORD_LENGTH = 14;
/** bcrypt solo usa los primeros 72 bytes: más allá daría una falsa sensación de seguridad. */
export const MAX_CLI_PASSWORD_BYTES = 72;
export const CLI_BCRYPT_COST = 12;
/** Palabra que el operador escribe para confirmar la verificación de identidad (§3.7). */
export const IDENTITY_CONFIRMATION_WORD = 'VERIFICADA';

export class SetPasswordError extends Error {}

const NOTHING_CHANGED = 'No se ha cambiado nada.';

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

export type CliOptions = {
  /** Solo en modo demo: el correo ficticio puede ir por argumento. En otro caso se pide por prompt. */
  email?: string;
  resetMfa: boolean;
  allowNonDemo: boolean;
};

const BOOLEAN_FLAGS = new Set(['--reset-mfa', '--allow-non-demo']);
const USAGE = 'Opciones: [--email correo (solo cuentas demo)] [--reset-mfa] [--allow-non-demo].';

/**
 * Lee los argumentos. Falla cerrado: cualquier opción desconocida o argumento suelto aborta antes de
 * conectar con la base de datos. Ningún secreto se acepta por argumentos (`--password` y similares
 * no existen) y las opciones de claves de desarrollo (`--allow-dev-secret`) se rechazan siempre,
 * con aviso explícito si la DATABASE_URL no es local. Los mensajes nunca repiten el valor recibido.
 */
export function parseCliArgs(argv: string[], databaseUrl: string | undefined): CliOptions {
  const options: CliOptions = { resetMfa: false, allowNonDemo: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    if (name === '--email') {
      if (options.email !== undefined) throw new SetPasswordError(`--email solo puede aparecer una vez. ${NOTHING_CHANGED}`);
      const value = inline ?? argv[++i];
      if (!isValidEmailArg(value)) throw new SetPasswordError(`--email necesita un correo válido. ${NOTHING_CHANGED}`);
      options.email = value;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name) && inline === undefined) {
      if (name === '--reset-mfa') options.resetMfa = true;
      else options.allowNonDemo = true;
      continue;
    }
    if (/^--allow-dev|dev-secret|insecure|skip-confirm/i.test(name)) {
      const where = isLocalDatabaseUrl(databaseUrl) ? '' : ', y menos contra una base de datos remota';
      throw new SetPasswordError(`${name.startsWith('--') ? name : 'Esa opción'} no existe en este CLI${where}: no usa claves de desarrollo ni se salta confirmaciones. ${NOTHING_CHANGED}`);
    }
    if (/pass|secret|token|totp|code|mfa/i.test(name)) {
      throw new SetPasswordError(`Las contraseñas y los códigos nunca se pasan por argumentos: se piden sin eco. ${NOTHING_CHANGED}`);
    }
    throw new SetPasswordError(`Argumento no reconocido. ${USAGE} ${NOTHING_CHANGED}`);
  }
  if (options.allowNonDemo && options.email !== undefined) {
    throw new SetPasswordError(`Con --allow-non-demo el correo no va por argumentos (quedaría en el historial): se pide al ejecutar. ${NOTHING_CHANGED}`);
  }
  return options;
}

export type AccountSummary = {
  userId: string;
  isDemo: boolean;
  mfaEnabled: boolean;
  memberships: { workspaceId: string; workspaceName: string; role: string }[];
};

const NO_ACCOUNT = `No hay ninguna cuenta de profesional con ese correo. ${NOTHING_CHANGED}`;
const NO_ACTIVE_WORKSPACE = `La cuenta no tiene ningún espacio activo: no puede entrar y no se puede auditar el cambio. ${NOTHING_CHANGED}`;
const NOT_DEMO = `La cuenta no es de demo. Para una profesional real sigue el manual §3.7 con --allow-non-demo. ${NOTHING_CHANGED}`;

/** Cuenta, MFA y membresías ACTIVE (espacio y rol), para que el operador confirme que es la correcta. */
export async function describeAccount(prisma: PrismaClient, rawEmail: string): Promise<AccountSummary> {
  const email = normalizeEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, isDemo: true, totpEnabled: true } });
  if (!user) throw new SetPasswordError(NO_ACCOUNT);
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    select: { workspaceId: true, role: true, workspace: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return {
    userId: user.id,
    isDemo: user.isDemo === true,
    mfaEnabled: user.totpEnabled === true,
    memberships: memberships.map((m) => ({ workspaceId: m.workspaceId, workspaceName: m.workspace.name, role: String(m.role) })),
  };
}

/** E/S del CLI, inyectable para poder probar el flujo completo sin terminal. */
export type CliIo = {
  print(line: string): void;
  /** Línea visible (correo, confirmaciones). */
  ask(prompt: string): Promise<string>;
  /** Línea sin eco (contraseña). */
  askHidden(prompt: string): Promise<string>;
};

/**
 * Flujo completo: 1) correo (argumento solo en modo demo; si no, prompt); 2) muestra si la cuenta es
 * demo y el espacio y el rol de cada membresía ACTIVE; 3) pide volver a escribir el correo y aborta si
 * no coincide; 4) fuera de demo, confirma la verificación de identidad (§3.7); 5) pide la contraseña
 * dos veces sin eco; 6) cambia, revoca y audita en una transacción.
 */
export async function runSetPasswordFlow(prisma: PrismaClient, options: CliOptions, io: CliIo): Promise<SetPasswordResult> {
  const email = options.email ?? (await io.ask('Correo de la cuenta: '));
  if (!isValidEmailArg(email)) throw new SetPasswordError(`Correo no válido. ${NOTHING_CHANGED}`);

  const account = await describeAccount(prisma, email);
  if (!options.allowNonDemo && !account.isDemo) throw new SetPasswordError(NOT_DEMO);
  if (account.memberships.length === 0) throw new SetPasswordError(NO_ACTIVE_WORKSPACE);

  io.print(`Cuenta ${account.isDemo ? 'DEMO (ficticia)' : 'REAL (no demo)'}. Espacios activos:`);
  for (const m of account.memberships) io.print(`  - ${m.workspaceName} (rol ${m.role})`);
  if (options.resetMfa) {
    io.print(account.mfaEnabled
      ? 'Se BORRARÁ su verificación en dos pasos y sus códigos de recuperación: en el siguiente acceso tendrá que configurarla de nuevo.'
      : 'La cuenta no tiene la verificación en dos pasos activa: --reset-mfa no cambia nada en ese apartado.');
  }

  const typed = await io.ask('Vuelve a escribir el correo de la cuenta para confirmar: ');
  if (normalizeEmail(typed) !== normalizeEmail(email)) throw new SetPasswordError(`El correo no coincide. ${NOTHING_CHANGED}`);

  if (!account.isDemo) {
    io.print('Cuenta real: solo tras su petición desde el correo registrado y la videollamada en la que la reconoces (manual §3.7).');
    const word = await io.ask(`Escribe ${IDENTITY_CONFIRMATION_WORD} si has verificado su identidad así: `);
    if (word.trim() !== IDENTITY_CONFIRMATION_WORD) throw new SetPasswordError(`Identidad no confirmada. ${NOTHING_CHANGED}`);
  }

  const first = await io.askHidden('Contraseña nueva (no se muestra): ');
  const second = await io.askHidden('Repítela: ');
  const problem = validateNewPassword(first, second);
  if (problem) throw new SetPasswordError(`${problem} ${NOTHING_CHANGED}`);
  return setUserPassword(prisma, { email, password: first, resetMfa: options.resetMfa, allowNonDemo: options.allowNonDemo });
}

export type SetPasswordResult = {
  userId: string;
  revokedSessions: number;
  auditedWorkspaces: number;
  mfaReset: boolean;
};

export async function setUserPassword(
  prisma: PrismaClient,
  input: { email: string; password: string; resetMfa?: boolean; allowNonDemo?: boolean; now?: Date },
): Promise<SetPasswordResult> {
  const email = normalizeEmail(input.email);
  const resetMfa = input.resetMfa === true;
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, isDemo: true, tokenVersion: true, passwordHash: true, totpEnabled: true },
  });
  if (!user) throw new SetPasswordError(NO_ACCOUNT);
  // Por defecto solo cuentas demo: restablecer a una profesional real exige --allow-non-demo.
  if (input.allowNonDemo !== true && user.isDemo !== true) throw new SetPasswordError(NOT_DEMO);

  // Solo membresías ACTIVE: una baja (REMOVED) no puede entrar ni recibe el registro.
  const memberships = await prisma.workspaceMember.findMany({ where: { userId: user.id, status: 'ACTIVE' }, select: { workspaceId: true } });
  const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))];
  // AuditLog exige workspaceId: sin espacio activo no hay dónde auditar (y la cuenta no puede entrar).
  if (workspaceIds.length === 0) throw new SetPasswordError(NO_ACTIVE_WORKSPACE);

  const passwordHash = await hash(input.password, CLI_BCRYPT_COST);
  const now = input.now ?? new Date();
  const currentTokenVersion = user.tokenVersion ?? 0;
  const mfaReset = resetMfa && user.totpEnabled === true;
  const demoAccount = user.isDemo === true;

  return prisma.$transaction(async (tx) => {
    // Compare-and-set sobre lo leído: si otro cambio de credenciales se cruzó, no se pisa.
    const claim = await tx.user.updateMany({
      where: { id: user.id, tokenVersion: currentTokenVersion, passwordHash: user.passwordHash },
      data: {
        passwordHash,
        tokenVersion: currentTokenVersion + 1,
        passwordChangedAt: now,
        mfaFailedAttempts: 0,
        mfaLockedUntil: null,
        // Sin TOTP, JwtAuthGuard responde 403 MFA_SETUP_REQUIRED a OWNER/ADMIN/THERAPIST hasta configurarlo.
        ...(resetMfa ? { totpSecret: null, totpEnabled: false, mfaRecoveryCodes: [], totpLastUsedStep: null } : {}),
      },
    });
    if (claim.count !== 1) throw new SetPasswordError(`La cuenta cambió mientras tanto (otro cambio de credenciales). Vuelve a ejecutarlo. ${NOTHING_CHANGED}`);

    const revoked = await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
    const base = { actorId: null, entityType: 'User', entityId: user.id }; // lo ejecuta el operador, no el usuario
    await tx.auditLog.createMany({
      data: workspaceIds.flatMap((workspaceId) => [
        { ...base, workspaceId, action: PASSWORD_RESET_CLI_ACTION, metadata: { via: 'cli', revokedSessions: revoked.count, demoAccount, mfaReset } },
        ...(mfaReset ? [{ ...base, workspaceId, action: MFA_RESET_CLI_ACTION, metadata: { via: 'cli', demoAccount } }] : []),
      ]),
    });
    return { userId: user.id, revokedSessions: revoked.count, auditedWorkspaces: workspaceIds.length, mfaReset };
  });
}
