import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ExportsService } from './exports.service';

@ApiTags('exports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get('patients/:patientId')
  patient(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string) {
    return this.exportsService.exportPatient(user, patientId);
  }

  @Get('workspace')
  workspace(@CurrentUser() user: AuthUser) {
    return this.exportsService.exportWorkspace(user);
  }

  @Get('pilot-readiness')
  readiness(@CurrentUser() user: AuthUser) {
    return this.exportsService.getPilotReadiness(user);
  }
}
