import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { accessModesAllowing, PORTAL_CLOSED_PATIENT_STATUSES } from '../portal/portal-access-mode.util';
import { ActivatePortalAccountDto } from './dto/portal-signup.dto';
import { ACTIVATION_INVALID_MESSAGE, ACTIVATION_TTL_MS, generateToken, hashToken } from './portal-signup.config';

type Tx = Prisma.TransactionClient;

/**
 * Enlace de activación (poner contraseña) de una cuenta de portal creada al aceptar una solicitud
 * de alta. Un solo uso, caduca a las 72 h, solo se guarda su hash y emitir otro revoca los
 * anteriores. Lo entrega la consulta por el mismo canal que la activación manual de hoy (en
 * persona, o mostrado como QR en la pantalla): no hay envío de email.
 */
@Injectable()
export class PortalActivationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Dentro de la transacción del llamante (que audita). Devuelve el token en claro UNA vez. */
  static async issue(tx: Tx, params: { workspaceId: string; patientId: string; portalAccountId: string; actorId: string }) {
    const { workspaceId, patientId, portalAccountId, actorId } = params;
    const now = new Date();
    await tx.portalActivationToken.updateMany({
      where: { workspaceId, portalAccountId, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + ACTIVATION_TTL_MS);
    const row = await tx.portalActivationToken.create({
      data: { workspaceId, patientId, portalAccountId, tokenHash: hashToken(token), expiresAt, createdById: actorId },
      select: { id: true },
    });
    return { activationTokenId: row.id, token, expiresAt };
  }

  /** Revoca los enlaces vivos de un paciente (al desactivar su portal o activarlo a mano). */
  static async revokeForPatient(tx: Tx, workspaceId: string, patientId: string) {
    await tx.portalActivationToken.updateMany({
      where: { workspaceId, patientId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Emite un enlace nuevo para una cuenta aún pendiente (p. ej. el anterior caducó). */
  async reissue(workspaceId: string, actor: AuthUser, patientId: string) {
    assertStaffRole(actor);
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId, deletedAt: null }, select: { id: true } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    if (actor.role === 'THERAPIST') {
      const treats = await this.prisma.clinicalProcess.findFirst({ where: { workspaceId, patientId, therapistId: actor.sub }, select: { id: true } });
      if (!treats) throw new NotFoundException('Paciente no encontrado');
    } else if (!['OWNER', 'ADMIN', 'ASSISTANT'].includes(actor.role)) {
      throw new ForbiddenException('No autorizado');
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.patient.updateMany({
        where: { id: patientId, workspaceId, deletedAt: null, status: { notIn: [...PORTAL_CLOSED_PATIENT_STATUSES] }, portalAccessMode: { in: accessModesAllowing('PATIENT') } },
        data: { updatedAt: new Date() },
      });
      if (!count) throw new BadRequestException('No se puede activar el portal de este paciente');
      const account = await tx.patientPortalAccount.findFirst({
        where: { workspaceId, patientId, accessorType: 'PATIENT', pendingActivation: true, isActive: false },
        select: { id: true },
      });
      if (!account) throw new NotFoundException('Este paciente no tiene una cuenta pendiente de activación');
      const issued = await PortalActivationService.issue(tx, { workspaceId, patientId, portalAccountId: account.id, actorId: actor.sub });
      await tx.auditLog.create({
        data: {
          workspaceId, actorId: actor.sub, action: 'PORTAL_ACTIVATION_LINK_ISSUED', entityType: 'PatientPortalAccount', entityId: account.id,
          metadata: { patientId, activationTokenId: issued.activationTokenId, expiresAt: issued.expiresAt.toISOString() },
        },
      });
      // Solo en persona (QR o código en la pantalla de la consulta); nunca por correo ni teléfono.
      return { portalAccountId: account.id, activation: { token: issued.token, expiresAt: issued.expiresAt, delivery: 'IN_PERSON_ONLY' as const } };
    });
  }

  /**
   * Endpoint público: el paciente pone su contraseña. Consumo atómico del token (UPDATE con
   * usedAt IS NULL, revokedAt IS NULL y expiresAt > ahora en el WHERE): dos canjes simultáneos →
   * solo uno prospera. Usado, caducado, revocado o inexistente → el mismo 400 genérico.
   */
  async redeem(dto: ActivatePortalAccountDto) {
    const tokenHash = hashToken(dto.token);
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const invalid = () => new BadRequestException({ statusCode: 400, code: 'PORTAL_ACTIVATION_INVALID', message: ACTIVATION_INVALID_MESSAGE });

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const row = await tx.portalActivationToken.findFirst({
        where: { tokenHash, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        select: { id: true, workspaceId: true, patientId: true, portalAccountId: true },
      });
      if (!row) throw invalid();
      const { workspaceId, patientId, portalAccountId } = row;

      const consumed = await tx.portalActivationToken.updateMany({
        where: { id: row.id, workspaceId, tokenHash, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (!consumed.count) throw invalid();

      // El paciente sigue admitiendo cuenta propia (no bloqueado/archivado, modo compatible).
      const patientOk = await tx.patient.updateMany({
        where: { id: patientId, workspaceId, deletedAt: null, status: { notIn: [...PORTAL_CLOSED_PATIENT_STATUSES] }, portalAccessMode: { in: accessModesAllowing('PATIENT') } },
        data: { updatedAt: now },
      });
      if (!patientOk.count) throw invalid();

      const activated = await tx.patientPortalAccount.updateMany({
        where: { id: portalAccountId, workspaceId, patientId, accessorType: 'PATIENT', pendingActivation: true, isActive: false },
        data: { passwordHash, pendingActivation: false, isActive: true, mustChangePassword: false, failedLoginAttempts: 0, lockedUntil: null },
      });
      if (!activated.count) throw invalid();

      await tx.auditLog.create({
        data: {
          workspaceId, actorId: null, action: 'PORTAL_ACCOUNT_ACTIVATED', entityType: 'PatientPortalAccount', entityId: portalAccountId,
          metadata: { patientId, activationTokenId: row.id, origin: 'QR_SIGNUP' },
        },
      });
      return { ok: true };
    });
  }
}
