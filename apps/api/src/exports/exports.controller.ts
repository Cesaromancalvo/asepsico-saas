import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ConfirmPasswordDto } from './dto/confirm-password.dto';
import { ExportsService } from './exports.service';

@ApiTags('exports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  // POST + contraseña, no GET: exportar es la acción de mayor impacto de la app, así que
  // exige reconfirmar la identidad (step-up auth) y de paso queda protegida por CSRF, que
  // nunca se aplica a un GET. El límite de intentos evita que alguien use este endpoint
  // para probar contraseñas por fuerza bruta.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('patients/:patientId')
  patient(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string, @Body() dto: ConfirmPasswordDto) {
    return this.exportsService.exportPatient(user, patientId, dto.password);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('workspace')
  workspace(@CurrentUser() user: AuthUser, @Body() dto: ConfirmPasswordDto) {
    return this.exportsService.exportWorkspace(user, dto.password);
  }

  // Solo estados/contadores, sin contenido sensible: se queda como GET, no necesita el
  // mismo nivel de fricción.
  @Get('pilot-readiness')
  readiness(@CurrentUser() user: AuthUser) {
    return this.exportsService.getPilotReadiness(user);
  }
}
