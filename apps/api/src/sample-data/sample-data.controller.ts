import { Body, Controller, Get, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ClearSampleDataDto } from './dto/clear-sample-data.dto';
import { SampleDataService } from './sample-data.service';

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

/** E1 · Datos de ejemplo del espacio de prueba (piloto demo). Todo SOLO OWNER (403 al resto). */
@ApiTags('sample-data')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('sample-data')
export class SampleDataController {
  constructor(private readonly sampleData: SampleDataService) {}

  // Estado: si se cargaron, cuándo se borraron, cuántos pacientes de ejemplo quedan y cuál tiene portal.
  @Get()
  @Header('Cache-Control', 'no-store')
  status(@CurrentUser() user: AuthUser) {
    return this.sampleData.status(user.workspaceId, user);
  }

  // Contraseña temporal NUEVA del paciente de prueba, una sola vez. Auditado (sin la contraseña).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('portal-access')
  issuePortalAccess(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.sampleData.issuePortalAccess(user.workspaceId, user, meta(req));
  }

  // «Borrar los datos de ejemplo»: confirmación { confirm: true }. Solo pacientes isDemo. Auditado.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('clear')
  clear(@CurrentUser() user: AuthUser, @Body() dto: ClearSampleDataDto, @Req() req: Request) {
    return this.sampleData.clear(user.workspaceId, user, meta(req));
  }
}
