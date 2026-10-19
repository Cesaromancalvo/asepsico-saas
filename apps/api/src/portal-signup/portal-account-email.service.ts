import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { releasedEmailPlaceholder } from '../portal/portal-email.util';

/**
 * Liberar un correo "ocupado" por error (ver portal/portal-email.util.ts). Solo OWNER/ADMIN de la
 * consulta titular de la cuenta, solo cuentas ya desactivadas y con el correo SIN verificar.
 */
@Injectable()
export class PortalAccountEmailService {
  constructor(private readonly prisma: PrismaService) {}

  async release(workspaceId: string, actor: AuthUser, patientId: string, accountId: string) {
    assertStaffRole(actor);
    if (!['OWNER', 'ADMIN'].includes(actor.role)) throw new ForbiddenException('Solo la titular o la administración de la consulta puede liberar un correo');
    const scope = { id: accountId, workspaceId, patientId };
    const account = await this.prisma.patientPortalAccount.findFirst({ where: scope, select: { id: true, isActive: true, pendingActivation: true, emailVerifiedAt: true } });
    if (!account) throw new NotFoundException('Cuenta de portal no encontrada');
    if (account.isActive || account.pendingActivation) throw new ConflictException('Desactiva primero el portal de esta cuenta');
    if (account.emailVerifiedAt) throw new ConflictException('Un correo verificado no se libera desde aquí');

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.patientPortalAccount.updateMany({
        where: { ...scope, isActive: false, pendingActivation: false, emailVerifiedAt: null },
        data: { email: releasedEmailPlaceholder(accountId) },
      });
      if (!count) throw new ConflictException('La cuenta ha cambiado; recarga y vuelve a intentarlo');
      await tx.portalActivationToken.updateMany({ where: { workspaceId, portalAccountId: accountId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: 'PORTAL_ACCOUNT_EMAIL_RELEASED', entityType: 'PatientPortalAccount', entityId: accountId, metadata: { patientId } },
      });
      return { ok: true };
    });
  }
}
