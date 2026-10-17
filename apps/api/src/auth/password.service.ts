import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { decryptField } from '../common/crypto/field-encryption';
import { AuthService, IssuedSession } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RESET_FAILURES, fail, reject } from './mfa-attempt';
import { MfaActor, MfaService, RequestMeta, stepNotYetUsed } from './mfa.service';
import { STAFF_BCRYPT_COST } from './password-policy';
import { verifyTotpCode } from './totp.util';

export const PASSWORD_CHANGED_ACTION = 'USER_PASSWORD_CHANGED';
export const PASSWORD_CHANGE_FAILED_ACTION = 'USER_PASSWORD_CHANGE_FAILED';

/** Códigos estables para la web (no depende del texto). */
export const CHANGE_PASSWORD_INVALID = 'CHANGE_PASSWORD_INVALID';
export const MFA_CODE_REQUIRED = 'MFA_CODE_REQUIRED';
export const PASSWORD_UNCHANGED = 'PASSWORD_UNCHANGED';

/**
 * Error único para contraseña actual o código incorrectos. Con MFA no se distingue cuál de los dos
 * falló; sin MFA solo puede ser la contraseña. 401 con mensaje propio: la web no lo confunde con un
 * access token caducado (no renueva ni repite la petición, ver BUSINESS_401_PATHS en apps/web/lib/api.ts).
 */
function invalidCredentials(mfaEnabled: boolean) {
  return new UnauthorizedException({
    statusCode: 401,
    code: CHANGE_PASSWORD_INVALID,
    message: mfaEnabled ? 'La contraseña actual o el código no son correctos.' : 'La contraseña actual no es correcta.',
  });
}

/**
 * Cambio de contraseña del propio profesional (POST /auth/change-password).
 *
 * - Corre dentro de MfaService.runAttempt: lock por usuario, espera creciente y contador de fallos
 *   compartidos con el MFA. Una contraseña o un código incorrectos cuentan como fallo de la cuenta.
 * - Con MFA activo exige además un TOTP no usado todavía (anti-reutilización, igual que el login).
 *   No acepta códigos de recuperación: esos son para entrar sin el móvil, no para cambiar credenciales.
 * - En UNA transacción: nuevo hash (condicionado al hash leído, sin pisar un cambio concurrente),
 *   revocación de TODOS los refresh tokens del usuario (en todos sus workspaces), AuditLog
 *   USER_PASSWORD_CHANGED en el workspace del token y emisión de una sesión nueva para este navegador.
 *   Si algo falla, no cambia nada.
 * - La auditoría de éxito no lleva datos personales: ni correo, ni IP, ni user-agent, ni contraseñas.
 */
@Injectable()
export class PasswordService {
  constructor(private mfa: MfaService, private auth: AuthService) {}

  async changePassword(actor: MfaActor, dto: ChangePasswordDto, meta: RequestMeta): Promise<IssuedSession> {
    // Comparación de dos entradas del propio usuario: no revela nada de lo guardado.
    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException({ statusCode: 400, code: PASSWORD_UNCHANGED, message: 'La nueva contraseña debe ser distinta de la actual.' });
    }

    return this.mfa.runAttempt(actor, PASSWORD_CHANGE_FAILED_ACTION, meta, {
      // Rechazo que no cuenta como fallo y no comprueba la contraseña: falta el código.
      preCheck: (user) =>
        user.totpEnabled && !dto.mfaCode
          ? reject(null, new BadRequestException({ statusCode: 400, code: MFA_CODE_REQUIRED, message: 'Introduce el código de tu app de verificación.' }))
          : null,
      attempt: async (tx, user) => {
        const mfaEnabled = user.totpEnabled === true;
        if (!(await compare(dto.currentPassword, user.passwordHash))) {
          return fail('invalid_credentials', invalidCredentials(mfaEnabled));
        }

        let step: number | null = null;
        if (mfaEnabled) {
          if (!user.totpSecret) return fail('invalid_credentials', invalidCredentials(true));
          step = await verifyTotpCode(decryptField(user.totpSecret)!, dto.mfaCode!, user.totpLastUsedStep);
          if (step === null) return fail('invalid_credentials', invalidCredentials(true));
        }

        // Rol actual de la BD, acotado al workspace del token (no se fía del rol del JWT).
        const member = await tx.workspaceMember.findFirst({
          where: { userId: user.id, workspaceId: actor.workspaceId },
          select: { role: true },
        });
        if (!member) return reject(null, new UnauthorizedException());

        const passwordHash = await hash(dto.newPassword, STAFF_BCRYPT_COST);
        const claim = await tx.user.updateMany({
          where: {
            id: user.id,
            passwordHash: user.passwordHash,
            ...(step !== null ? { totpEnabled: true, totpSecret: user.totpSecret, ...stepNotYetUsed(step) } : { totpEnabled: false }),
          },
          data: { passwordHash, ...(step !== null ? { totpLastUsedStep: step } : {}), ...RESET_FAILURES },
        });
        if (claim.count !== 1) return fail('state_changed_or_code_reused', invalidCredentials(mfaEnabled));

        const revoked = await tx.refreshToken.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            workspaceId: actor.workspaceId,
            actorId: user.id,
            action: PASSWORD_CHANGED_ACTION,
            entityType: 'User',
            entityId: user.id,
            metadata: { revokedSessions: revoked.count, mfaVerified: step !== null },
          },
        });
        const session = await this.auth.issueSession(
          { ...user, totpEnabled: mfaEnabled },
          actor.workspaceId,
          member.role,
          meta,
          undefined,
          tx,
        );
        return { kind: 'ok', value: session };
      },
    });
  }
}
