import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { buildInviteUrl, generateInviteToken, hashInviteToken, INVITE_TTL_MS, normalizeEmail } from '../auth/invite-token.util';
import { CreateMemberInviteDto } from './dto/create-member-invite.dto';
import { clinicianFlagForRole } from './member-role.util';

// Nunca se devuelve tokenHash: el token solo existe en la respuesta de creación.
const INVITE_SELECT = {
  id: true,
  email: true,
  role: true,
  isClinician: true,
  invitedById: true,
  expiresAt: true,
  createdAt: true,
  acceptedAt: true,
  revokedAt: true,
} as const;

/**
 * Invitaciones de miembros a un workspace EXISTENTE (no crean workspaces: eso solo lo hace la
 * plataforma con npm run invites:create). Solo el OWNER invita y revoca; rol e isClinician quedan
 * fijados en la invitación de forma coherente (THERAPIST clínico, ASSISTANT no, nunca OWNER).
 */
@Injectable()
export class WorkspaceInvitesService {
  constructor(private readonly prisma: PrismaService) {}

  private async actorRole(workspaceId: string, actor: AuthUser) {
    const member = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId: actor.sub }, select: { role: true } });
    return member?.role ?? null;
  }

  private async assertOwner(workspaceId: string, actor: AuthUser) {
    assertStaffRole(actor);
    if ((await this.actorRole(workspaceId, actor)) !== 'OWNER') {
      throw new ForbiddenException('Solo el propietario puede gestionar invitaciones');
    }
  }

  async create(workspaceId: string, actor: AuthUser, dto: CreateMemberInviteDto, meta: { ip?: string; userAgent?: string }) {
    await this.assertOwner(workspaceId, actor);
    const isClinician = clinicianFlagForRole(dto.role, dto.isClinician);
    const email = normalizeEmail(dto.email);
    // Solo se comprueba la pertenencia a ESTE workspace: no se revela si el correo existe en otro.
    const alreadyMember = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, user: { email } }, select: { id: true } });
    if (alreadyMember) throw new BadRequestException('Esa persona ya forma parte del equipo');

    const token = generateInviteToken();
    const now = new Date();
    const invite = await this.prisma.$transaction(async (tx) => {
      // Una sola invitación viva por correo y workspace: las anteriores quedan revocadas.
      await tx.workspaceInvite.updateMany({
        where: { workspaceId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      const created = await tx.workspaceInvite.create({
        data: {
          workspaceId,
          email,
          role: dto.role,
          isClinician,
          invitedById: actor.sub,
          tokenHash: hashInviteToken(token),
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        },
        select: INVITE_SELECT,
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'MEMBER_INVITED',
          entityType: 'WorkspaceInvite',
          entityId: created.id,
          metadata: { role: dto.role, isClinician },
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
        },
      });
      return created;
    });
    // El enlace se muestra UNA vez al OWNER para que lo envíe él (no hay envío de correo aún).
    return { ...invite, inviteUrl: buildInviteUrl('/join', token) };
  }

  /** OWNER/ADMIN: invitaciones del workspace (sin token). */
  async list(workspaceId: string, actor: AuthUser) {
    assertStaffRole(actor);
    const role = await this.actorRole(workspaceId, actor);
    if (role !== 'OWNER' && role !== 'ADMIN') throw new ForbiddenException('Solo propietarios y administradores gestionan el equipo');
    return this.prisma.workspaceInvite.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 100, select: INVITE_SELECT });
  }

  async revoke(workspaceId: string, actor: AuthUser, inviteId: string, meta: { ip?: string; userAgent?: string }) {
    await this.assertOwner(workspaceId, actor);
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.workspaceInvite.updateMany({
        where: { id: inviteId, workspaceId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw new NotFoundException('Invitación no encontrada o ya no está pendiente');
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'MEMBER_INVITE_REVOKED',
          entityType: 'WorkspaceInvite',
          entityId: inviteId,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
        },
      });
      return { success: true };
    });
  }
}
