import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { waitlistAllowedOrigins } from './waitlist.config';

/**
 * Además de CORS (que solo frena a los navegadores), el endpoint público exige que la cabecera
 * Origin sea uno de WAITLIST_ALLOWED_ORIGINS. Un navegador siempre la envía en una petición
 * cross-origin (la landing está en otro origen que la API), así que una petición sin Origin o
 * con otro Origin no viene del formulario de asepsico.es. Un script puede falsearla: para eso
 * están el rate limit, el token de formulario y el honeypot.
 */
@Injectable()
export class WaitlistOriginGuard implements CanActivate {
  private readonly logger = new Logger('Waitlist');

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.header('origin');
    if (!origin || !waitlistAllowedOrigins().includes(origin)) {
      this.logger.warn('Petición rechazada: origen no permitido');
      throw new ForbiddenException('Origen no permitido');
    }
    return true;
  }
}
