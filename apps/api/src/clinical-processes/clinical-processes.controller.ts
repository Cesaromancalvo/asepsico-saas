import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ClinicalProcessesService } from './clinical-processes.service';
import { CreateClinicalProcessDto } from './dto/create-clinical-process.dto';
import { UpdateClinicalProcessDto } from './dto/update-clinical-process.dto';
import { ChangeClinicalProcessStatusDto } from './dto/change-clinical-process-status.dto';
import { ListClinicalProcessesQueryDto } from './dto/list-clinical-processes-query.dto';

@ApiTags('clinical-processes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('clinical-processes')
export class ClinicalProcessesController {
  constructor(private readonly service: ClinicalProcessesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListClinicalProcessesQueryDto) {
    return this.service.list(user.workspaceId, user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.get(user.workspaceId, user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateClinicalProcessDto) {
    return this.service.create(user.workspaceId, user, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateClinicalProcessDto) {
    return this.service.update(user.workspaceId, user, id, dto);
  }

  @Patch(':id/status')
  changeStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ChangeClinicalProcessStatusDto) {
    return this.service.changeStatus(user.workspaceId, user, id, dto.status);
  }
}
