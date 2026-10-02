import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { getCurrentLegalDocuments } from '../legal/legal-documents';
import { assertAcceptsCurrentTerms, assertLegalDocumentsPublishable, legalDocumentRef, recordTermsAcceptances } from '../legal/terms-acceptance';
import { clinicianFlagForRole, INVITABLE_ROLES } from '../workspace-members/member-role.util';
import { AuthService } from './auth.service';
import { RegisterDto, RegisterMemberDto } from './dto/register.dto';
import { hashInviteToken, normalizeEmail } from './invite-token.util';

export const REGISTRATION_NOT_ALLOWED = 'REGISTRATION_NOT_ALLOWED';

/** Política de privacidad vigente (con texto) para informar al miembro que se da de alta. */
function privacyNoticeFor(docs: ReturnType<typeof getCurrentLegalDocuments>) {
  const doc = docs.find((d) => d.type === 'PRIVACY_PRODUCT');
  return doc ? { ...legalDocumentRef(doc), text: doc.text } : null;
}

type Meta = { ip?: string; userAgent?: string };

/**
 * Altas de cuenta. El registro está CERRADO: solo con una invitación válida, de un solo uso,
 * no caducada y emitida al mismo correo. Cualquier fallo de la invitación (ausente, desconocida,
 * usada, revocada, caducada, de otro correo) o un correo ya registrado recibe la MISMA respuesta
 * neutra, para no revelar qué invitaciones o cuentas existen.
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(private readonly prisma: PrismaService, private readonly auth: AuthService) {}

  /** Workspace nuevo con su OWNER (invitación de plataforma + aceptación de las condiciones vigentes). */
  async register(dto: RegisterDto, meta: Meta) {
    const docs = getCurrentLegalDocuments();
    assertLegalDocumentsPublishable(docs);
    assertAcceptsCurrentTerms(dto.acceptedTerms, docs);
    const email = normalizeEmail(dto.email);
    const now = new Date();

    const invite = dto.inviteToken
      ? await this.prisma.registrationInvite.findUnique({ where: { tokenHash: hashInviteToken(dto.inviteToken) } })
      : null;
    if (!invite) this.reject('registro', 'invitación ausente o desconocida');
    if (invite.usedAt) this.reject('registro', 'invitación ya usada', invite.id);
    if (invite.revokedAt) this.reject('registro', 'invitación revocada', invite.id);
    if (invite.expiresAt <= now) this.reject('registro', 'invitación caducada', invite.id);
    if (invite.email !== email) this.reject('registro', 'el correo no coincide con la invitación', invite.id);
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) this.reject('registro', 'correo ya registrado', invite.id);

    const passwordHash = await hash(dto.password, 12);
    const isClinician = dto.isClinician === true;
    const result = await this.runOrNeutral('registro', invite.id, () => this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, passwordHash, firstName: dto.firstName, lastName: dto.lastName } });
      const workspace = await tx.workspace.create({ data: { name: dto.workspaceName } });
      // Consumo atómico (compare-and-set): dos registros simultáneos con el mismo token → solo uno.
      const claim = await tx.registrationInvite.updateMany({
        where: { id: invite.id, tokenHash: invite.tokenHash, email, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now, usedByUserId: user.id, workspaceId: workspace.id },
      });
      if (claim.count !== 1) this.reject('registro', 'invitación consumida en paralelo', invite.id);
      const membership = await tx.workspaceMember.create({ data: { userId: user.id, workspaceId: workspace.id, role: 'OWNER', isClinician } });
      await recordTermsAcceptances(tx, { workspaceId: workspace.id, userId: user.id, docs, meta });
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorId: user.id,
          action: 'WORKSPACE_REGISTERED',
          entityType: 'Workspace',
          entityId: workspace.id,
          metadata: { registrationInviteId: invite.id, role: 'OWNER', isClinician },
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
        },
      });
      return { user, workspaceId: workspace.id, role: membership.role };
    }));

    const session = await this.auth.issueSession(result.user, result.workspaceId, result.role, meta);
    return { mfaRequired: false as const, ...session };
  }

  /** Alta de un miembro invitado por el OWNER: rol e isClinician salen de la invitación. */
  async registerMember(dto: RegisterMemberDto, meta: Meta) {
    const email = normalizeEmail(dto.email);
    const now = new Date();

    const invite = dto.inviteToken
      ? await this.prisma.workspaceInvite.findUnique({ where: { tokenHash: hashInviteToken(dto.inviteToken) } })
      : null;
    if (!invite) this.reject('miembro', 'invitación ausente o desconocida');
    if (invite.acceptedAt) this.reject('miembro', 'invitación ya usada', invite.id);
    if (invite.revokedAt) this.reject('miembro', 'invitación revocada', invite.id);
    if (invite.expiresAt <= now) this.reject('miembro', 'invitación caducada', invite.id);
    if (invite.email !== email) this.reject('miembro', 'el correo no coincide con la invitación', invite.id);
    if (!(INVITABLE_ROLES as readonly string[]).includes(invite.role)) this.reject('miembro', 'rol no invitable', invite.id);
    // Hoy una cuenta pertenece a un solo workspace (el login usa la membresía más antigua).
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) this.reject('miembro', 'correo ya registrado', invite.id);

    // Coherencia rol/isClinician recalculada (además de los CHECK de la BD).
    const isClinician = clinicianFlagForRole(invite.role, invite.isClinician);
    // Art. 13 RGPD: al miembro se le INFORMA de la política de privacidad vigente (no la acepta:
    // el contrato lo firma el titular). Queda en la auditoría qué versión se le mostró.
    const privacyNotice = privacyNoticeFor(getCurrentLegalDocuments());
    const passwordHash = await hash(dto.password, 12);
    const result = await this.runOrNeutral('miembro', invite.id, () => this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, passwordHash, firstName: dto.firstName, lastName: dto.lastName } });
      const claim = await tx.workspaceInvite.updateMany({
        where: { id: invite.id, workspaceId: invite.workspaceId, tokenHash: invite.tokenHash, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now, acceptedUserId: user.id },
      });
      if (claim.count !== 1) this.reject('miembro', 'invitación consumida en paralelo', invite.id);
      const membership = await tx.workspaceMember.create({
        data: { workspaceId: invite.workspaceId, userId: user.id, role: invite.role, isClinician },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: invite.workspaceId,
          actorId: user.id,
          action: 'MEMBER_JOINED',
          entityType: 'WorkspaceMember',
          entityId: membership.id,
          metadata: {
            workspaceInviteId: invite.id, invitedById: invite.invitedById, role: invite.role, isClinician,
            privacyNoticeVersion: privacyNotice?.version ?? null, privacyNoticeHash: privacyNotice?.textHash ?? null,
          },
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
        },
      });
      return { user, workspaceId: invite.workspaceId, role: membership.role };
    }));

    const session = await this.auth.issueSession(result.user, result.workspaceId, result.role, meta);
    return { mfaRequired: false as const, ...session, privacyNotice };
  }

  /** Respuesta neutra. El motivo solo va al log del servidor (sin correo ni token). */
  private reject(kind: string, reason: string, inviteId?: string): never {
    this.logger.warn(`Alta (${kind}) rechazada: ${reason}${inviteId ? ` [invitación ${inviteId}]` : ''}`);
    throw new BadRequestException({
      statusCode: 400,
      code: REGISTRATION_NOT_ALLOWED,
      message: 'No se ha podido completar el registro. Revisa el enlace de invitación o pide uno nuevo.',
    });
  }

  /** Un correo dado de alta en paralelo (P2002) también recibe la respuesta neutra. */
  private async runOrNeutral<T>(kind: string, inviteId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.reject(kind, 'conflicto de unicidad al crear la cuenta', inviteId);
      }
      throw error;
    }
  }
}
