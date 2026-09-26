import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';

/**
 * Serialización por usuario de los intentos de segundo factor.
 *
 * Problema (hallazgo de Argos): si la espera y el agotamiento del pendingToken se comprueban
 * con el usuario leído al principio, N peticiones simultáneas ven "sin espera" y todas
 * evalúan su código, saltándose el límite por cuenta.
 *
 * Solución: cada intento corre en una transacción interactiva que primero toma
 * `pg_try_advisory_xact_lock` sobre el userId. Dentro, y ya en exclusiva: se relee el
 * usuario, se comprueban espera y agotamiento, se verifica el código y se registra el fallo
 * o el éxito. El lock se libera solo al terminar la transacción (commit o rollback).
 *
 * Por qué advisory lock NO bloqueante (try) y no `SELECT ... FOR UPDATE`:
 * - FOR UPDATE haría esperar a las peticiones concurrentes, cada una ocupando una conexión
 *   del pool mientras dura la verificación (bcrypt incluido): una ráfaga contra una cuenta
 *   podría agotar el pool de toda la API. Con el try, la petición que no consigue el lock
 *   responde 429 al momento y suelta la conexión.
 * - No depende de la fila ni del nivel de aislamiento, y no requiere columnas nuevas.
 * Coste: un usuario legítimo que envía dos códigos a la vez recibe 429 en uno de ellos.
 *
 * El namespace ('asepsico:mfa') separa estos locks de cualquier otro advisory lock; una
 * colisión de hashtext entre dos userId solo produciría un 429 espurio, nunca un bypass.
 */

/** Espera creciente: desde el 5.º fallo, 1 min por fallo; desde el 10.º, 5 min; desde el 15.º, 15 min (tope). */
const MFA_LOCK_TIERS: ReadonlyArray<{ fromFailures: number; lockMs: number }> = [
  { fromFailures: 15, lockMs: 15 * 60_000 },
  { fromFailures: 10, lockMs: 5 * 60_000 },
  { fromFailures: 5, lockMs: 60_000 },
];

/** Fallos tras los que un pendingToken de login queda anulado (hay que volver a poner la contraseña). */
export const MFA_PENDING_TOKEN_MAX_FAILURES = 5;

export function mfaLockDurationMs(failedAttempts: number): number {
  return MFA_LOCK_TIERS.find((tier) => failedAttempts >= tier.fromFailures)?.lockMs ?? 0;
}

/** Datos que se escriben con toda verificación correcta: se olvidan los fallos previos. */
export const RESET_FAILURES = { mfaFailedAttempts: 0, mfaLockedUntil: null } as const;

/** Tiempo máximo de la transacción: cubre bcrypt de contraseña + hasta 10 códigos de recuperación. */
export const MFA_ATTEMPT_TX_OPTIONS = { maxWait: 5_000, timeout: 20_000 };

export type MfaTx = Prisma.TransactionClient;

/**
 * Resultado de un intento dentro de la sección exclusiva:
 * - ok: éxito (quien lo devuelve ya escribió el cambio y la auditoría con `tx`).
 * - fail: intento fallido que cuenta para el límite (código o contraseña incorrectos).
 * - reject: rechazo que no cuenta (estado incorrecto, token agotado…).
 */
export type MfaAttemptResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'fail'; reason: string; error: HttpException }
  | { kind: 'reject'; reason: string | null; error: HttpException; auditAction?: string };

export function fail(reason: string, error: HttpException): MfaAttemptResult<never> {
  return { kind: 'fail', reason, error };
}

/** `reason` null = no se audita. `auditAction` sustituye a la acción de fallo por defecto. */
export function reject(reason: string | null, error: HttpException, auditAction?: string): MfaAttemptResult<never> {
  return { kind: 'reject', reason, error, auditAction };
}

/** Toma el lock del usuario para esta transacción. false = otro intento en curso. */
export async function tryLockUserForMfa(tx: MfaTx, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtext('asepsico:mfa'), hashtext(${userId})) AS acquired`;
  return rows[0]?.acquired === true;
}

export function busyError(): HttpException {
  return new HttpException(
    'Ya hay una verificación en curso para esta cuenta. Inténtalo de nuevo en unos segundos.',
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** Espera restante en ms (0 si no hay). Usa Date.now() para ser determinista en tests. */
export function remainingLockMs(user: Pick<User, 'mfaLockedUntil'>): number {
  return Math.max(0, (user.mfaLockedUntil?.getTime() ?? 0) - Date.now());
}

export function lockedError(remainingMs: number): HttpException {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return new HttpException(
    `Demasiados intentos fallidos. Espera ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} antes de volver a intentarlo.`,
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
