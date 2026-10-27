import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../database/prisma.service';
import { isPlatformAdmin } from './platform-admin.config';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformWaitlistService } from './platform-waitlist.service';

export class PlatformConfirmPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}

/** Actor de MfaService.runAttempt (contador de fallos por cuenta del propio admin). */
const actorOf = (user: AuthUser) => ({ userId: user.sub, workspaceId: user.workspaceId });

/**
 * API de plataforma (PLATFORM_ADMIN). Fuera de Swagger para no anunciarla.
 * Contrato: packages/contracts/src/platform-waitlist.ts.
 *  - GET  /admin/me                     → { platformAdmin } (cualquier sesión; no audita).
 *  - GET  /admin/waitlist               → lista + contadores (audita PLATFORM_WAITLIST_VIEWED).
 *  - POST /admin/waitlist/:id/delete    → 204 (contraseña; audita SUPPRESSED o REAUTH_FAILED).
 *  - POST /admin/waitlist/:id/phone/delete → 204 (contraseña; borra SOLO el teléfono; audita
 *                                          PHONE_CLEARED o REAUTH_FAILED).
 * Cualquier no admin recibe 404 en /admin/waitlist*. Todo con Cache-Control: no-store.
 */
@ApiExcludeController()
@Controller('admin')
export class PlatformController {
  constructor(private readonly prisma: PrismaService, private readonly waitlist: PlatformWaitlistService) {}

  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return { platformAdmin: await isPlatformAdmin(this.prisma, user) };
  }

  @UseGuards(PlatformAdminGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Get('waitlist')
  list(@CurrentUser() user: AuthUser) {
    return this.waitlist.list(user.sub);
  }

  // PlatformAdminGuard ANTES de CsrfGuard: un no admin ve 404, no un 403 de CSRF.
  @UseGuards(PlatformAdminGuard, CsrfGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  @Post('waitlist/:id/delete')
  async delete(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PlatformConfirmPasswordDto) {
    await this.waitlist.suppress(actorOf(user), id, dto.password);
  }

  // Retirada del consentimiento para llamadas (política v5): borra solo el teléfono. Mismas
  // protecciones que la supresión: 404 para no admins, CSRF, contraseña y límite de 5/min.
  @UseGuards(PlatformAdminGuard, CsrfGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  @Post('waitlist/:id/phone/delete')
  async deletePhone(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PlatformConfirmPasswordDto) {
    await this.waitlist.clearPhone(actorOf(user), id, dto.password);
  }
}
