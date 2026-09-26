import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { compare } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { decryptField, encryptField } from '../common/crypto/field-encryption';
import { generateTotpSecret, getTotpUri, getTotpQrCodeDataUrl, verifyTotpCode } from './totp.util';
import { generateRecoveryCodes, hashRecoveryCodes, findMatchingRecoveryCodeIndex } from './recovery-codes.util';
import {
  MFA_ATTEMPT_TX_OPTIONS,
  MFA_PENDING_TOKEN_MAX_FAILURES,
  MfaAttemptResult,
  MfaTx,
  RESET_FAILURES,
  busyError,
  fail,
  lockedError,
  mfaLockDurationMs,
  reject,
  remainingLockMs,
  tryLockUserForMfa,
} from './mfa-attempt';

export { MFA_PENDING_TOKEN_MAX_FAILURES, mfaLockDurationMs } from './mfa-attempt';

export type RequestMeta = { ip?: string; userAgent?: string };

/** Usuario sobre el que se opera el MFA y workspace en el que se registra la auditoría. */
export type MfaActor = { userId: string; workspaceId: string };

const MFA_ALREADY_ENABLED_MESSAGE =
  'La verificación en dos pasos ya está activa. Para configurarla de nuevo, desactívala primero con tu contraseña y un código.';

/** Condición atómica anti-reutilización (RFC 6238 §5.2): el paso TOTP debe ser posterior al último usado. */
function stepNotYetUsed(step: number): Prisma.UserWhereInput {
  return { OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }] };
}

/** Entrada de auditoría de MFA. La metadata nunca lleva secretos, códigos ni tokens. */
function mfaAudit(
  actor: MfaActor,
  action: string,
  meta: RequestMeta,
  metadata: Record<string, string | number | boolean>,
): Prisma.AuditLogUncheckedCreateInput {
  return {
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    action,
    entityType: 'User',
    entityId: actor.userId,
    metadata,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  };
}

/**
 * Ciclo de vida del segundo factor (TOTP + códigos de recuperación).
 *
 * Reglas:
 * - Cada código TOTP vale una sola vez: se guarda el paso con el que coincidió
 *   (User.totpLastUsedStep) y se reclama con un updateMany condicional.
 * - Cada código de recuperación vale una sola vez: se consume con concurrencia optimista
 *   (la lista guardada debe seguir siendo la que se leyó).
 * - Los intentos de login/mfa, confirm y disable se serializan por usuario (ver
 *   mfa-attempt.ts): espera, agotamiento del pendingToken, verificación y registro del
 *   resultado ocurren en exclusiva, así que el límite no se salta con peticiones simultáneas.
 * - Los fallos cuentan por cuenta (no por IP) y activan una espera creciente.
 * - Éxitos, fallos y rechazos se auditan en la misma transacción que su cambio.
 */
@Injectable()
export class MfaService {
  constructor(private prisma: PrismaService) {}

  /**
   * Genera un secreto TOTP y el QR para escanearlo. Si ya había un secreto pendiente de
   * confirmar (el usuario le dio dos veces al botón, tiene varias pestañas abiertas, o
   * recargó la página a medio proceso), se reutiliza el mismo secreto en vez de generar
   * uno nuevo — así el QR que ya escaneó sigue siendo válido y no hay que repetir el
   * escaneo.
   *
   * Si el MFA ya está activo se rechaza (400): reconfigurarlo exige desactivarlo antes con
   * contraseña + código TOTP o de recuperación (POST /auth/mfa/disable). Así una sesión
   * robada no basta para sustituir el segundo factor. No verifica ningún código, así que
   * no pasa por el límite de intentos.
   */
  async setupMfa(actor: MfaActor, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId } });
    if (!user) throw new UnauthorizedException();
    if (user.totpEnabled) {
      await this.prisma.auditLog.create({ data: mfaAudit(actor, 'MFA_SETUP_REJECTED', meta, { reason: 'already_enabled' }) });
      throw new BadRequestException(MFA_ALREADY_ENABLED_MESSAGE);
    }

    let secret: string;
    if (user.totpSecret) {
      secret = decryptField(user.totpSecret)!;
      await this.prisma.auditLog.create({ data: mfaAudit(actor, 'MFA_SETUP_STARTED', meta, { pendingSecretReused: true }) });
    } else {
      const candidate = generateTotpSecret();
      const stored = await this.prisma.$transaction(async (tx) => {
        // Solo si sigue sin MFA y sin secreto pendiente: no pisa un setup/confirm concurrente.
        const claim = await tx.user.updateMany({
          where: { id: user.id, totpEnabled: false, totpSecret: null },
          data: { totpSecret: encryptField(candidate), totpLastUsedStep: null },
        });
        if (claim.count !== 1) return false;
        await tx.auditLog.create({ data: mfaAudit(actor, 'MFA_SETUP_STARTED', meta, { pendingSecretReused: false }) });
        return true;
      });
      if (stored) {
        secret = candidate;
      } else {
        const current = await this.prisma.user.findUnique({ where: { id: user.id } });
        if (!current?.totpSecret || current.totpEnabled) {
          throw new BadRequestException('No se pudo iniciar la configuración de MFA, inténtalo de nuevo');
        }
        secret = decryptField(current.totpSecret)!;
        await this.prisma.auditLog.create({ data: mfaAudit(actor, 'MFA_SETUP_STARTED', meta, { pendingSecretReused: true }) });
      }
    }

    const uri = getTotpUri(secret, user.email);
    const qrCodeDataUrl = await getTotpQrCodeDataUrl(uri);
    return { qrCodeDataUrl, secret };
  }

  /**
   * Activa el MFA. Exige la contraseña actual además del TOTP: con solo una sesión robada,
   * un atacante podría activar el MFA con SU móvil en una cuenta que aún no lo tenía y dejar
   * fuera al dueño.
   */
  async confirmMfaSetup(actor: MfaActor, password: string, code: string, meta: RequestMeta) {
    return this.runAttempt(actor, 'MFA_CONFIRM_FAILED', meta, {
      preCheck: (user) => {
        if (user.totpEnabled) {
          return reject('already_enabled', new BadRequestException(MFA_ALREADY_ENABLED_MESSAGE), 'MFA_CONFIRM_REJECTED');
        }
        if (!user.totpSecret) return reject(null, new BadRequestException('Primero tienes que iniciar la configuración de MFA'));
        return null;
      },
      attempt: async (tx, user) => {
        if (!(await compare(password, user.passwordHash))) {
          return fail('bad_password', new UnauthorizedException('Contraseña incorrecta'));
        }
        const step = await verifyTotpCode(decryptField(user.totpSecret)!, code, user.totpLastUsedStep);
        if (step === null) return fail('invalid_code', new UnauthorizedException('El código no es correcto'));

        const recoveryCodes = generateRecoveryCodes();
        const hashedCodes = await hashRecoveryCodes(recoveryCodes);
        const claim = await tx.user.updateMany({
          where: { id: user.id, totpEnabled: false, totpSecret: user.totpSecret, ...stepNotYetUsed(step) },
          data: { totpEnabled: true, mfaRecoveryCodes: hashedCodes, totpLastUsedStep: step, ...RESET_FAILURES },
        });
        if (claim.count !== 1) {
          return fail('code_already_used_or_state_changed', new UnauthorizedException('El código no es correcto o ya se ha utilizado'));
        }
        await tx.auditLog.create({ data: mfaAudit(actor, 'MFA_ENABLED', meta, { recoveryCodesIssued: recoveryCodes.length }) });
        return { kind: 'ok', value: { recoveryCodes } };
      },
    });
  }

  async disableMfa(actor: MfaActor, password: string, code: string, meta: RequestMeta) {
    return this.runAttempt(actor, 'MFA_DISABLE_FAILED', meta, {
      attempt: async (tx, user) => {
        if (!(await compare(password, user.passwordHash))) {
          return fail('invalid_password', new UnauthorizedException('Contraseña incorrecta'));
        }
        if (!user.totpEnabled || !user.totpSecret) return reject(null, new BadRequestException('MFA no está activo'));

        const step = await verifyTotpCode(decryptField(user.totpSecret)!, code, user.totpLastUsedStep);
        let method: 'totp' | 'recovery_code';
        let guard: Prisma.UserWhereInput;
        if (step !== null) {
          method = 'totp';
          guard = { totpSecret: user.totpSecret, ...stepNotYetUsed(step) };
        } else {
          if ((await findMatchingRecoveryCodeIndex(code, user.mfaRecoveryCodes)) === -1) {
            return fail('invalid_code', new UnauthorizedException('Código no válido'));
          }
          method = 'recovery_code';
          guard = { mfaRecoveryCodes: { equals: user.mfaRecoveryCodes } };
        }

        const claim = await tx.user.updateMany({
          where: { id: user.id, totpEnabled: true, ...guard },
          data: { totpSecret: null, totpEnabled: false, mfaRecoveryCodes: [], totpLastUsedStep: null, ...RESET_FAILURES },
        });
        if (claim.count !== 1) {
          return fail('code_already_used_or_state_changed', new UnauthorizedException('Código no válido'));
        }
        if (method === 'recovery_code') {
          await tx.auditLog.create({ data: mfaAudit(actor, 'MFA_RECOVERY_CODE_USED', meta, { context: 'disable' }) });
        }
        await tx.auditLog.create({ data: mfaAudit(actor, 'MFA_DISABLED', meta, { method }) });
        return { kind: 'ok', value: { success: true } };
      },
    });
  }

  /**
   * Segundo paso del login: acepta un TOTP no usado todavía o un código de recuperación
   * (que se consume). Lanza 401 si no vale y 429 si la cuenta está en espera o hay otro
   * intento en curso. `failuresAtIssue` es el contador de fallos de la cuenta cuando se
   * emitió el pendingToken: tras MFA_PENDING_TOKEN_MAX_FAILURES fallos más, queda anulado.
   */
  async verifyLoginSecondFactor(actor: MfaActor, code: string, meta: RequestMeta, failuresAtIssue: number): Promise<void> {
    await this.runAttempt(actor, 'MFA_LOGIN_FAILED', meta, {
      preCheck: (user) => {
        if (!user.totpEnabled || !user.totpSecret) {
          return reject(null, new UnauthorizedException('No se pudo verificar el segundo factor'));
        }
        if (user.mfaFailedAttempts - failuresAtIssue >= MFA_PENDING_TOKEN_MAX_FAILURES) {
          return reject('pending_token_exhausted', new UnauthorizedException('Demasiados intentos fallidos, vuelve a iniciar sesión'));
        }
        return null;
      },
      attempt: async (tx, user) => {
        const step = await verifyTotpCode(decryptField(user.totpSecret)!, code, user.totpLastUsedStep);
        if (step !== null) {
          const claim = await tx.user.updateMany({
            where: { id: user.id, totpEnabled: true, totpSecret: user.totpSecret, ...stepNotYetUsed(step) },
            data: { totpLastUsedStep: step, ...RESET_FAILURES },
          });
          if (claim.count !== 1) return fail('code_already_used', new UnauthorizedException('Código no válido'));
          await tx.auditLog.create({ data: mfaAudit(actor, 'MFA_LOGIN_VERIFIED', meta, { method: 'totp' }) });
          return { kind: 'ok', value: undefined };
        }

        const matchIndex = await findMatchingRecoveryCodeIndex(code, user.mfaRecoveryCodes);
        if (matchIndex === -1) return fail('invalid_code', new UnauthorizedException('Código no válido'));
        const remainingCodes = user.mfaRecoveryCodes.filter((_, i) => i !== matchIndex);
        const claim = await tx.user.updateMany({
          where: { id: user.id, totpEnabled: true, mfaRecoveryCodes: { equals: user.mfaRecoveryCodes } },
          data: { mfaRecoveryCodes: remainingCodes, ...RESET_FAILURES },
        });
        if (claim.count !== 1) return fail('recovery_code_already_used', new UnauthorizedException('Código no válido'));
        await tx.auditLog.create({
          data: mfaAudit(actor, 'MFA_RECOVERY_CODE_USED', meta, { context: 'login', remainingRecoveryCodes: remainingCodes.length }),
        });
        return { kind: 'ok', value: undefined };
      },
    });
  }

  /**
   * Ejecuta un intento de segundo factor en exclusiva para el usuario:
   * lock → releer usuario → preCheck (rechazos que no cuentan) → espera activa (429) →
   * attempt → registrar fallo (contador + espera + auditoría) o devolver el éxito.
   * Los fallos y rechazos se confirman (commit) y se lanzan DESPUÉS de la transacción;
   * una excepción inesperada dentro (p. ej. fallo de auditoría) revierte todo.
   */
  private async runAttempt<T>(
    actor: MfaActor,
    failureAction: string,
    meta: RequestMeta,
    steps: {
      preCheck?: (user: User) => MfaAttemptResult<never> | null;
      attempt: (tx: MfaTx, user: User) => Promise<MfaAttemptResult<T>>;
    },
  ): Promise<T> {
    const outcome = await this.prisma.$transaction(async (tx): Promise<MfaAttemptResult<T> | { kind: 'busy' }> => {
      if (!(await tryLockUserForMfa(tx, actor.userId))) return { kind: 'busy' };
      const user = await tx.user.findUnique({ where: { id: actor.userId } });
      if (!user) return reject(null, new UnauthorizedException());

      const pre = steps.preCheck?.(user) ?? null;
      if (pre) {
        if (pre.kind === 'reject' && pre.reason) {
          await tx.auditLog.create({ data: mfaAudit(actor, pre.auditAction ?? failureAction, meta, { reason: pre.reason }) });
        }
        return pre;
      }

      const remainingMs = remainingLockMs(user);
      if (remainingMs > 0) {
        await tx.auditLog.create({ data: mfaAudit(actor, failureAction, meta, { reason: 'locked' }) });
        return reject(null, lockedError(remainingMs));
      }

      const result = await steps.attempt(tx, user);
      if (result.kind === 'fail') await this.registerFailure(tx, actor, failureAction, meta, result.reason);
      else if (result.kind === 'reject' && result.reason) {
        await tx.auditLog.create({ data: mfaAudit(actor, failureAction, meta, { reason: result.reason }) });
      }
      return result;
    }, MFA_ATTEMPT_TX_OPTIONS);

    if (outcome.kind === 'busy') {
      await this.prisma.auditLog.create({ data: mfaAudit(actor, failureAction, meta, { reason: 'concurrent_attempt' }) });
      throw busyError();
    }
    if (outcome.kind !== 'ok') throw outcome.error;
    return outcome.value;
  }

  /** Suma un fallo (incremento atómico), fija la espera si toca y lo audita, todo en `tx`. */
  private async registerFailure(tx: MfaTx, actor: MfaActor, action: string, meta: RequestMeta, reason: string) {
    const updated = await tx.user.update({
      where: { id: actor.userId },
      data: { mfaFailedAttempts: { increment: 1 } },
      select: { mfaFailedAttempts: true },
    });
    const lockMs = mfaLockDurationMs(updated.mfaFailedAttempts);
    if (lockMs > 0) {
      await tx.user.update({ where: { id: actor.userId }, data: { mfaLockedUntil: new Date(Date.now() + lockMs) } });
    }
    await tx.auditLog.create({
      data: mfaAudit(actor, action, meta, {
        reason,
        failedAttempts: updated.mfaFailedAttempts,
        ...(lockMs > 0 ? { lockedForSeconds: lockMs / 1000 } : {}),
      }),
    });
  }
}
