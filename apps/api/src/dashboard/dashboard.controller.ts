import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DashboardService } from './dashboard.service';
import { UpdateOnboardingDto } from './dto/update-onboarding.dto';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.dashboard.get(user);
  }

  @Patch('onboarding')
  updateOnboarding(@CurrentUser() user: AuthUser, @Body() dto: UpdateOnboardingDto) {
    return this.dashboard.updateOnboarding(user, dto);
  }
}
