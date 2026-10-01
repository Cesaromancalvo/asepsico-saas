import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { UpdateMemberClinicianDto } from './dto/update-member-clinician.dto';

const MEMBER_SELECT = {
  id: true,
  userId: true,
  role: true,
  isClinician: true,
  createdAt: true,
  user: { select: { firstName: true, lastName: true, email: true } },
} as const;

/**
 * Gestión administrativa del equipo. Marcar a alguien como profesional clínico (`isClinician`)
 * NO le da acceso a ningún paciente: el contenido clínico exige además un proceso ACTIVO.
 */
@Injectable()
export class WorkspaceMembersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Rol real del actor en la BD (el token puede estar desactualizado). */
  private async actorRole(workspaceId: string, actor: AuthUser) {
    const member = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId: actor.sub }, select: { role: true } });
    return member?.role ?? null;
  }

  async list(workspaceId: string, actor: AuthUser) {
    assertStaffRole(actor);
    const role = await this.actorRole(workspaceId, actor);
    if (role !== 'OWNER' && role !== 'ADMIN') throw new ForbiddenException('Solo propietarios y administradores gestionan el equipo');
    const members = await this.prisma.workspaceMember.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, select: MEMBER_SELECT });
    return members.map(toMemberView);
  }

  // TODO-E1: cuando exista el cambio de rol (o la invitación) de un miembro, fijar isClinician en
  // la MISMA transacción: ASSISTANT → false, THERAPIST → true (los CHECK de la BD lo exigen).

  /** Solo el OWNER (según la BD) cambia el atributo clínico. ASSISTANT nunca es clínico. */
  async setClinician(workspaceId: string, actor: AuthUser, userId: string, dto: UpdateMemberClinicianDto) {
    assertStaffRole(actor);
    if ((await this.actorRole(workspaceId, actor)) !== 'OWNER') {
      throw new ForbiddenException('Solo el propietario puede marcar profesionales clínicos');
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { id: true, role: true, isClinician: true } });
      if (!current) throw new NotFoundException('Miembro no encontrado');
      if (current.role === 'ASSISTANT') throw new BadRequestException('Un asistente no puede ser profesional clínico');
      if (current.role === 'THERAPIST') throw new BadRequestException('Un terapeuta siempre es profesional clínico');
      if (current.isClinician !== dto.isClinician) {
        // Escritura acotada al workspace, con compare-and-set del rol y del valor leído: nunca solo por id.
        const { count } = await tx.workspaceMember.updateMany({
          where: { id: current.id, workspaceId, role: { in: ['OWNER', 'ADMIN'] }, isClinician: current.isClinician },
          data: { isClinician: dto.isClinician },
        });
        if (count === 0) throw new BadRequestException('El miembro cambió mientras se guardaba; vuelve a intentarlo');
        await tx.auditLog.create({
          data: {
            workspaceId,
            actorId: actor.sub,
            action: 'MEMBER_CLINICIAN_CHANGED',
            entityType: 'WorkspaceMember',
            entityId: current.id,
            metadata: { userId, role: current.role, from: current.isClinician, to: dto.isClinician },
          },
        });
      }
      const saved = await tx.workspaceMember.findFirst({ where: { id: current.id, workspaceId }, select: MEMBER_SELECT });
      if (!saved) throw new NotFoundException('Miembro no encontrado');
      return toMemberView(saved);
    });
  }
}

type MemberRow = {
  id: string; userId: string; role: string; isClinician: boolean; createdAt: Date;
  user?: { firstName: string; lastName: string; email: string } | null;
};

function toMemberView(member: MemberRow) {
  return {
    id: member.id,
    userId: member.userId,
    role: member.role,
    isClinician: member.isClinician === true,
    createdAt: member.createdAt,
    firstName: member.user?.firstName ?? null,
    lastName: member.user?.lastName ?? null,
    email: member.user?.email ?? null,
  };
}
