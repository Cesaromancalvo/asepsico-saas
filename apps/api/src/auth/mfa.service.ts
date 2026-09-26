import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { compare } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { decryptField, encryptField } from '../common/crypto/field-encryption';
import { generateTotpSecret, getTotpUri, getTotpQrCodeDataUrl, verifyTotpCode } from './totp.util';
import { generateRecoveryCodes, hashRecoveryCodes, findMatchingRecoveryCodeIndex } from './recovery-codes.util';

export type RequestMeta = { ip?: string; userAgent?: string };

/** Usuario sobre el que se opera el MFA y workspace en el que se registra la auditoría. */
export type MfaActor = { userId: string; workspaceId: string };

const MFA_ALREADY_ENABLED_MESSAGE =
  'La verificación en dos pasos ya está activa. Para configurarla de nuevo, desactívala primero con tu contraseña y un código.';

/**
 * Espera creciente por cuenta tras fallos de segundo factor (TOTP, código de recuperación o
 * contraseña en confirm/disable). Nunca hay bloqueo permanente: el tope es 15 minutos.
 * El contador vuelve a 0 con cualquier verificación correcta.
 */
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

/** Condición atómica anti-reutilización (RFC 6238 §5.2): el paso TOTP debe ser posterior al último usado. */
function stepNotYetUsed(step: number): Prisma.UserWhereInput {
  return { OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }] };
}

/** Datos que se escriben con toda verificación correcta: se olvidan los fallos previos. */
const RESET_FAILURES = { mfaFailedAttempts: 0, mfaLockedUntil: null } as const;

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
 *   (User.totpLastUsedStep) y se reclama con un updateMany condicional, así que dos
 *   peticiones concurrentes con el mismo código no pueden ganar ambas.
 * - Cada código de recuperación vale una sola vez: se consume con concurrencia optimista
 *   (la lista guardada debe seguir siendo la que se leyó).
 * - Los fallos cuentan por cuenta (no por IP) y activan una espera creciente.
 * - Toda operación con éxito se audita en la misma transacción que el cambio; los fallos
 *   se auditan en la misma transacción que el incremento del contador.
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
   * robada no basta para sustituir el segundo factor.
   */
  async setupMfa(actor: MfaActor, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId } });
    if (!user) throw new UnauthorizedException();
    if (user.totpEnabled) {
      await this.auditFailure(actor, 'MFA_SETUP_REJECTED', meta, { reason: 'already_enabled' });
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
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId } });
    if (!user) throw new UnauthorizedException();
    if (user.totpEnabled) {
      await this.auditFailure(actor, 'MFA_CONFIRM_REJECTED', meta, { reason: 'already_enabled' });
      throw new BadRequestException(MFA_ALREADY_ENABLED_MESSAGE);
    }
    if (!user.totpSecret) throw new BadRequestException('Primero tienes que iniciar la configuración de MFA');
    await this.assertNotLocked(user, actor, 'MFA_CONFIRM_FAILED', meta);

    if (!(await compare(password, user.passwordHash))) {
      await this.registerFailure(actor, 'MFA_CONFIRM_FAILED', meta, 'bad_password');
      throw new UnauthorizedException('Contraseña incorrecta');
    }

    const secret = decryptField(user.totpSecret)!;
    const step = await verifyTotpCode(secret, code, user.totpLastUsedStep);
    if (step === null) {
      await this.registerFailure(actor, 'MFA_CONFIRM_FAILED', meta, 'invalid_code');
      throw new UnauthorizedException('El código no es correcto');
    }

    const recoveryCodes = generateRecoveryCodes();
    const hashedCodes = await hashRecoveryCodes(recoveryCodes);
    const enabled = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.user.updateMany({
        where: { id: user.id, totpEnabled: false, totpSecret: user.totpSecret, ...stepNotYetUsed(step) },
        data: { totpEnabled: true, mfaRecoveryCodes: hashedCodes, totpLastUsedStep: step, ...RESET_FAILURES },
      });
      if (claim.count !== 1) return false;
      await tx.auditLog.create({ data: mfaAudit(actor, 'MFA_ENABLED', meta, { recoveryCodesIssued: recoveryCodes.length }) });
      return true;
    });
    if (!enabled) {
      await this.registerFailure(actor, 'MFA_CONFIRM_FAILED', meta, 'code_already_used_or_state_changed');
      throw new UnauthorizedException('El código no es correcto o ya se ha utilizado');
    }
    return { recoveryCodes };
  }

  async disableMfa(actor: MfaActor, password: string, code: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId } });
    if (!user) throw new UnauthorizedException();
    await this.assertNotLocked(user, actor, 'MFA_DISABLE_FAILED', meta);
    const passwordOk = await compare(password, user.passwordHash);
    if (!passwordOk) {
      await this.registerFailure(actor, 'MFA_DISABLE_FAILED', meta, 'invalid_password');
      throw new UnauthorizedException('Contraseña incorrecta');
    }
    if (!user.totpEnabled || !user.totpSecret) throw new BadRequestException('MFA no está activo');

    const secret = decryptField(user.totpSecret)!;
    const step = await verifyTotpCode(secret, code, user.totpLastUsedStep);
    let method: 'totp' | 'recovery_code';
    let guard: Prisma.UserWhereInput;
    if (step !== null) {
      method = 'totp';
      guard = { totpSecret: user.totpSecret, ...stepNotYetUsed(step) };
    } else {
      const matchIndex = await findMatchingRecoveryCodeIndex(code, user.mfaRecoveryCodes);
      if (matchIndex === -1) {
        await this.registerFailure(actor, 'MFA_DISABLE_FAILED', meta, 'invalid_code');
        throw new UnauthorizedException('Código no válido');
      }
      method = 'recovery_code';
      guard = { mfaRecoveryCodes: { equals: user.mfaRecoveryCodes } };
    }

    const disabled = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.user.updateMany({
        where: { id: user.id, totpEnabled: true, ...guard },
        data: { totpSecret: null, totpEnabled: false, mfaRecoveryCodes: [], totpLastUsedStep: null, ...RESET_FAILURES },
      });
      if (claim.count !== 1) return false;
      if (method === 'recovery_code') {
        await tx.auditLog.create({ data: mfaAudit(actor, 'MFA_RECOVERY_CODE_USED', meta, { context: 'disable' }) });
      }
      await tx.auditLog.create({ data: mfaAudit(actor, 'MFA_DISABLED', meta, { method }) });
      return true;
    });
    if (!disabled) {
      await this.registerFailure(actor, 'MFA_DISABLE_FAILED', meta, 'code_already_used_or_state_changed');
      throw new UnauthorizedException('Código no válido');
    }
    return { success: true };
  }

  /**
   * Segundo paso del login: acepta un TOTP no usado todavía o un código de recuperación
   * (que se consume). Lanza 401 si no vale y 429 si la cuenta está en espera.
   * `failuresAtIssue` es el contador de fallos de la cuenta cuando se emitió el pendingToken:
   * si desde entonces ha habido MFA_PENDING_TOKEN_MAX_FAILURES fallos, el token queda anulado.
   */
  async verifyLoginSecondFactor(
    user: User,
    code: string,
    actor: MfaActor,
    meta: RequestMeta,
    failuresAtIssue: number,
  ): Promise<void> {
    if (!user.totpEnabled || !user.totpSecret) throw new UnauthorizedException('No se pudo verificar el segundo factor');
    if (user.mfaFailedAttempts - failuresAtIssue >= MFA_PENDING_TOKEN_MAX_FAILURES) {
      await this.auditFailure(actor, 'MFA_LOGIN_FAILED', meta, { reason: 'pending_token_exhausted' });
      throw new UnauthorizedException('Demasiados intentos fallidos, vuelve a iniciar sesión');
    }
    await this.assertNotLocked(user, actor, 'MFA_LOGIN_FAILED', meta);

    const secret = decryptField(user.totpSecret)!;
    const step = await verifyTotpCode(secret, code, user.totpLastUsedStep);

    if (step !== null) {
      const claimed = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.user.updateMany({
          where: { id: user.id, totpEnabled: true, totpSecret: user.totpSecret, ...stepNotYetUsed(step) },
          data: { totpLastUsedStep: step, ...RESET_FAILURES },
        });
        if (claim.count !== 1) return false;
        await tx.auditLog.create({ data: mfaAudit(actor, 'MFA_LOGIN_VERIFIED', meta, { method: 'totp' }) });
        return true;
      });
      if (!claimed) {
        await this.registerFailure(actor, 'MFA_LOGIN_FAILED', meta, 'code_already_used');
        throw new UnauthorizedException('Código no válido');
      }
      return;
    }

    const matchIndex = await findMatchingRecoveryCodeIndex(code, user.mfaRecoveryCodes);
    if (matchIndex === -1) {
      await this.registerFailure(actor, 'MFA_LOGIN_FAILED', meta, 'invalid_code');
      throw new UnauthorizedException('Código no válido');
    }
    const remainingCodes = user.mfaRecoveryCodes.filter((_, i) => i !== matchIndex);
    const consumed = await this.prisma.$transaction(async (tx) => {
      // Concurrencia optimista: solo se consume si la lista no ha cambiado desde que se leyó.
      const claim = await tx.user.updateMany({
        where: { id: user.id, totpEnabled: true, mfaRecoveryCodes: { equals: user.mfaRecoveryCodes } },
        data: { mfaRecoveryCodes: remainingCodes, ...RESET_FAILURES },
      });
      if (claim.count !== 1) return false;
      await tx.auditLog.create({
        data: mfaAudit(actor, 'MFA_RECOVERY_CODE_USED', meta, { context: 'login', remainingRecoveryCodes: remainingCodes.length }),
      });
      return true;
    });
    if (!consumed) {
      await this.registerFailure(actor, 'MFA_LOGIN_FAILED', meta, 'recovery_code_already_used');
      throw new UnauthorizedException('Código no válido');
    }
  }

  /** 429 si la cuenta está en espera. Durante la espera no se comprueba el código ni se cuenta el intento. */
  private async assertNotLocked(user: User, actor: MfaActor, action: string, meta: RequestMeta) {
    const lockedUntil = user.mfaLockedUntil?.getTime() ?? 0;
    const remainingMs = lockedUntil - Date.now();
    if (remainingMs <= 0) return;
    await this.auditFailure(actor, action, meta, { reason: 'locked' });
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    throw new HttpException(
      `Demasiados intentos fallidos. Espera ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} antes de volver a intentarlo.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Suma un fallo a la cuenta y, si toca, fija la espera. Incremento atómico en BD (no
   * leer-sumar-escribir) para que peticiones concurrentes no se pisen el contador.
   */
  private async registerFailure(actor: MfaActor, action: string, meta: RequestMeta, reason: string) {
    await this.prisma.$transaction(async (tx) => {
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
    });
  }

  /** Rechazo que no es un intento de adivinar nada (p. ej. MFA ya activo): solo se audita. */
  private async auditFailure(actor: MfaActor, action: string, meta: RequestMeta, metadata: Record<string, string>) {
    await this.prisma.auditLog.create({ data: mfaAudit(actor, action, meta, metadata) });
  }
}
