import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UpdateMemberClinicianDto } from './dto/update-member-clinician.dto';
import { WorkspaceMembersService } from './workspace-members.service';
import { WorkspaceInvitesService } from './workspace-invites.service';
import { CreateMemberInviteDto } from './dto/create-member-invite.dto';
import { ReassignMemberWorkDto, RemoveMemberDto } from './dto/remove-member.dto';
import { MemberRemovalService } from './member-removal.service';

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

@ApiTags('workspace-members')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('workspace-members')
export class WorkspaceMembersController {
  constructor(
    private readonly members: WorkspaceMembersService,
    private readonly invites: WorkspaceInvitesService,
    private readonly removal: MemberRemovalService,
  ) {}

  // Solo OWNER. Auditado. Devuelve el enlace UNA vez (token en el fragmento #invite=).
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Post('invites')
  createInvite(@CurrentUser() user: AuthUser, @Body() dto: CreateMemberInviteDto, @Req() req: Request) {
    return this.invites.create(user.workspaceId, user, dto, meta(req));
  }

  // OWNER/ADMIN: invitaciones del workspace (sin token).
  @Get('invites')
  listInvites(@CurrentUser() user: AuthUser) {
    return this.invites.list(user.workspaceId, user);
  }

  // Solo OWNER. Auditado.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Delete('invites/:inviteId')
  revokeInvite(@CurrentUser() user: AuthUser, @Param('inviteId') inviteId: string, @Req() req: Request) {
    return this.invites.revoke(user.workspaceId, user, inviteId, meta(req));
  }

  // OWNER/ADMIN: equipo con rol e isClinician (datos administrativos).
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.members.list(user.workspaceId, user);
  }

  // Solo OWNER. Auditado. Rechaza ASSISTANT (400).
  @Patch(':userId/clinician')
  setClinician(@CurrentUser() user: AuthUser, @Param('userId') userId: string, @Body() dto: UpdateMemberClinicianDto) {
    return this.members.setClinician(user.workspaceId, user, userId, dto);
  }

  // OWNER/ADMIN (ADMIN solo sobre THERAPIST/ASSISTANT): recuentos antes de la baja y destinos
  // posibles. Sin pacientes ni contenido clínico.
  @Header('Cache-Control', 'no-store')
  @Get(':userId/removal-preview')
  removalPreview(@CurrentUser() user: AuthUser, @Param('userId') userId: string) {
    return this.removal.preview(user.workspaceId, user, userId);
  }

  // OWNER/ADMIN (ADMIN solo sobre THERAPIST/ASSISTANT). Baja con corte de acceso inmediato,
  // reasignación opcional y auditoría en la misma transacción. Nunca a uno mismo ni al último OWNER.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':userId/remove')
  remove(@CurrentUser() user: AuthUser, @Param('userId') userId: string, @Body() dto: RemoveMemberDto) {
    return this.removal.remove(user.workspaceId, user, userId, dto);
  }

  // OWNER/ADMIN: reasigna después ("decidir después") el trabajo de un miembro ya dado de baja.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':userId/reassign')
  reassign(@CurrentUser() user: AuthUser, @Param('userId') userId: string, @Body() dto: ReassignMemberWorkDto) {
    return this.removal.reassignWork(user.workspaceId, user, userId, dto);
  }
}
