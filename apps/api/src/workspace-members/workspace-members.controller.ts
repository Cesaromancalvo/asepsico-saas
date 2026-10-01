import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UpdateMemberClinicianDto } from './dto/update-member-clinician.dto';
import { WorkspaceMembersService } from './workspace-members.service';

@ApiTags('workspace-members')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('workspace-members')
export class WorkspaceMembersController {
  constructor(private readonly members: WorkspaceMembersService) {}

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
}
