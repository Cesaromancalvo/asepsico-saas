import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { decryptField, encryptField } from '../common/crypto/field-encryption';
import { isClinicalProfile } from '../clinical-access/clinical-access.service';
import { generateToken, hashToken } from './portal-signup.config';

/**
 * QR / enlace de alta FIJO de cada profesional clínico.
 *
 * Quién lo gestiona (ver, rotar, desactivar):
 *  - el propio profesional (THERAPIST, u OWNER/ADMIN con perfil clínico) para el suyo;
 *  - OWNER/ADMIN para cualquier profesional clínico del workspace.
 *  - ASSISTANT no (no imprime ni rota QR ajenos; sí revisa solicitudes, ver SignupRequestsService).
 *
 * Profesional de otro workspace, inexistente o sin perfil clínico → 404 (no se revela nada).
 * El token en claro solo se devuelve a quien puede gestionarlo; nunca va a logs ni auditoría.
 */
@Injectable()
export class IntakeLinksService {
  constructor(private readonly prisma: PrismaService) {}

  /** 'me' = el propio actor. */
  resolveProfessionalId(actor: AuthUser, professionalId: string): string {
    return professionalId === 'me' ? actor.sub : professionalId;
  }

  private async assertCanManage(workspaceId: string, actor: AuthUser, professionalId: string) {
    assertStaffRole(actor);
    if (!['OWNER', 'ADMIN', 'THERAPIST'].includes(actor.role)) throw new ForbiddenException('No autorizado');
    if (actor.role === 'THERAPIST' && actor.sub !== professionalId) throw new NotFoundException('Profesional no encontrado');
    // Dado de baja (REMOVED) → 404: nadie rota ni reactiva su QR impreso.
    const target = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId: professionalId, status: 'ACTIVE' },
      select: { role: true, isClinician: true },
    });
    if (!target || !isClinicalProfile({ role: target.role, isClinician: target.isClinician === true })) {
      throw new NotFoundException('Profesional no encontrado');
    }
  }

  async get(workspaceId: string, actor: AuthUser, rawProfessionalId: string) {
    const professionalId = this.resolveProfessionalId(actor, rawProfessionalId);
    await this.assertCanManage(workspaceId, actor, professionalId);
    const link = await this.prisma.portalIntakeLink.findFirst({
      where: { workspaceId, professionalId },
      select: { isActive: true, rotatedAt: true, tokenEncrypted: true },
    });
    if (!link) return { professionalId, exists: false, isActive: false, rotatedAt: null, token: null };
    return {
      professionalId,
      exists: true,
      isActive: link.isActive,
      rotatedAt: link.rotatedAt,
      // Desactivado: no se vuelve a mostrar (para usarlo hay que rotar, lo que genera otro).
      token: link.isActive ? decryptField(link.tokenEncrypted) ?? null : null,
    };
  }

  /** Crea el QR del profesional o lo rota: el anterior deja de valer en el mismo commit. */
  async rotate(workspaceId: string, actor: AuthUser, rawProfessionalId: string) {
    const professionalId = this.resolveProfessionalId(actor, rawProfessionalId);
    await this.assertCanManage(workspaceId, actor, professionalId);
    const token = generateToken();
    const data = { tokenHash: hashToken(token), tokenEncrypted: encryptField(token)!, isActive: true, rotatedAt: new Date() };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.portalIntakeLink.findFirst({ where: { workspaceId, professionalId }, select: { id: true } });
        let linkId: string;
        if (existing) {
          const { count } = await tx.portalIntakeLink.updateMany({ where: { id: existing.id, workspaceId, professionalId }, data });
          if (!count) throw new ConflictException('El QR ha cambiado; recarga y vuelve a intentarlo');
          linkId = existing.id;
        } else {
          const created = await tx.portalIntakeLink.create({ data: { workspaceId, professionalId, createdById: actor.sub, ...data }, select: { id: true } });
          linkId = created.id;
        }
        await tx.auditLog.create({
          data: {
            workspaceId, actorId: actor.sub, action: existing ? 'PORTAL_INTAKE_LINK_ROTATED' : 'PORTAL_INTAKE_LINK_CREATED',
            entityType: 'PortalIntakeLink', entityId: linkId, metadata: { professionalId },
          },
        });
        return { professionalId, isActive: true, rotatedAt: data.rotatedAt, token };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('El QR ha cambiado; recarga y vuelve a intentarlo');
      }
      throw error;
    }
  }

  /** Apaga el QR (escanearlo deja de crear solicitudes). Las solicitudes ya recibidas siguen pendientes. */
  async disable(workspaceId: string, actor: AuthUser, rawProfessionalId: string) {
    const professionalId = this.resolveProfessionalId(actor, rawProfessionalId);
    await this.assertCanManage(workspaceId, actor, professionalId);
    return this.prisma.$transaction(async (tx) => {
      const link = await tx.portalIntakeLink.findFirst({ where: { workspaceId, professionalId }, select: { id: true } });
      if (!link) throw new NotFoundException('Este profesional no tiene QR de alta');
      await tx.portalIntakeLink.updateMany({ where: { id: link.id, workspaceId, professionalId }, data: { isActive: false } });
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: 'PORTAL_INTAKE_LINK_DISABLED', entityType: 'PortalIntakeLink', entityId: link.id, metadata: { professionalId } },
      });
      return { professionalId, isActive: false };
    });
  }
}
