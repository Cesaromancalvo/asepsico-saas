import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateResourceDto, UpdateResourceDto } from './dto/resource.dto';
import { ResourcesService } from './resources.service';

@ApiTags('resources')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller()
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get('resources') list(@CurrentUser() user: AuthUser, @Query('q') q?: string) { return this.resources.list(user.workspaceId, user, q); }
  @Post('resources') create(@CurrentUser() user: AuthUser, @Body() dto: CreateResourceDto) { return this.resources.create(user.workspaceId, user, dto); }
  @Patch('resources/:id') update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateResourceDto) { return this.resources.update(user.workspaceId, user, id, dto); }
  @Delete('resources/:id') archive(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.resources.archive(user.workspaceId, user, id); }

  @Get('patients/:patientId/resources') listForPatient(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string) { return this.resources.listForPatient(user.workspaceId, user, patientId); }
  @Post('patients/:patientId/resources/:resourceId/share') share(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string, @Param('resourceId') resourceId: string) { return this.resources.share(user.workspaceId, user, patientId, resourceId); }
  @Delete('patients/:patientId/resources/:resourceId/share') revoke(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string, @Param('resourceId') resourceId: string) { return this.resources.revoke(user.workspaceId, user, patientId, resourceId); }
}
