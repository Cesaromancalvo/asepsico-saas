import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export type PortalRateLimitOptions = { bucket: string; limit: number; windowMs: number };

const PORTAL_RATE_LIMIT = 'portal-rate-limit';

/** Límite por CUENTA de portal (además del límite global por IP del ThrottlerGuard). */
export const PortalRateLimit = (options: PortalRateLimitOptions) => SetMetadata(PORTAL_RATE_LIMIT, options);

const MAX_KEYS = 20_000;

/**
 * Ventana fija en memoria por cuenta de portal y "bucket". Va DESPUÉS de PortalGuard en
 * @UseGuards (necesita req.portalUser). Es por instancia, como el ThrottlerGuard actual; la
 * creación de solicitudes tiene además un límite en base de datos (5/hora por cuenta).
 */
@Injectable()
export class PortalRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.get<PortalRateLimitOptions | undefined>(PORTAL_RATE_LIMIT, context.getHandler());
    if (!options) return true;
    const req = context.switchToHttp().getRequest();
    const accountId: string | undefined = req.portalUser?.portalAccountId;
    // Sin cuenta de portal no se llega aquí (PortalGuard va antes); si pasara, se niega.
    if (!accountId) throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);

    const now = Date.now();
    const key = `${options.bucket}:${accountId}`;
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= MAX_KEYS) this.sweep(now);
      this.hits.set(key, { count: 1, resetAt: now + options.windowMs });
      return true;
    }
    entry.count += 1;
    if (entry.count > options.limit) {
      throw new HttpException({ statusCode: 429, error: 'Too Many Requests', message: 'Demasiadas peticiones. Inténtalo en un momento.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  private sweep(now: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    if (this.hits.size >= MAX_KEYS) this.hits.clear();
  }
}
