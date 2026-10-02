import { Body, Controller, Get, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AcceptTermsDto } from './dto/accept-terms.dto';
import { LegalService } from './legal.service';

@ApiTags('legal')
@Controller('legal')
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  // Público: textos vigentes con versión y hash, para mostrarlos antes de registrarse.
  @Get('terms')
  terms() {
    return this.legal.currentDocuments();
  }

  // Cualquier miembro: ¿hay condiciones pendientes? (solo el OWNER puede aceptarlas).
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  @Get('terms/status')
  status(@CurrentUser() user: AuthUser) {
    return this.legal.status(user);
  }

  // Solo OWNER (según la BD). Auditado en la misma transacción.
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @HttpCode(200)
  @Post('terms/accept')
  accept(@CurrentUser() user: AuthUser, @Body() dto: AcceptTermsDto, @Req() req: Request) {
    return this.legal.accept(user, dto, { ip: req.ip, userAgent: req.get('user-agent') ?? undefined });
  }
}
