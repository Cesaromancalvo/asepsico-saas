import { Body, Controller, Get, Header, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CreateWaitlistEntryDto } from './dto/create-waitlist-entry.dto';
import { WaitlistOriginGuard } from './waitlist-origin.guard';
import { WaitlistService } from './waitlist.service';
import { WAITLIST_SUBMIT_THROTTLE, WAITLIST_TOKEN_THROTTLE } from './waitlist.config';

/**
 * Endpoints PÚBLICOS (sin JwtAuthGuard ni CsrfGuard: no hay sesión ni cookies que proteger).
 * CORS propio en src/config/cors.ts (solo WAITLIST_ALLOWED_ORIGINS, sin credenciales).
 * Contrato para la landing: packages/contracts/src/waitlist.ts.
 */
@ApiTags('public-waitlist')
@Controller('public/waitlist')
@UseGuards(WaitlistOriginGuard)
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Throttle(WAITLIST_TOKEN_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @Get('form-token')
  formToken() {
    return this.waitlist.formToken();
  }

  @Throttle(WAITLIST_SUBMIT_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @HttpCode(202)
  @Post()
  submit(@Body() dto: CreateWaitlistEntryDto) {
    return this.waitlist.submit(dto);
  }
}
