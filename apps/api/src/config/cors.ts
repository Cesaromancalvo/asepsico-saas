import type { CorsOptions, CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import { WAITLIST_PATH, waitlistAllowedOrigins } from '../waitlist/waitlist.config';

/**
 * CORS por ruta:
 *  - /api/v1/public/waitlist(/...): SOLO los orígenes de WAITLIST_ALLOWED_ORIGINS (la landing),
 *    sin credenciales (no hay cookies), solo GET/POST y Content-Type.
 *  - Todo lo demás: la app (WEB_ORIGIN) con credenciales, como hasta ahora. Los orígenes de la
 *    landing NO obtienen CORS en ningún otro endpoint.
 * Los orígenes se validan al construir el delegado (al arrancar): un valor mal escrito impide
 * el arranque en vez de abrir o cerrar CORS en silencio.
 */
export function isWaitlistPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return path === WAITLIST_PATH || path.startsWith(`${WAITLIST_PATH}/`);
}

export function buildCorsDelegate(env: NodeJS.ProcessEnv = process.env): CorsOptionsDelegate<{ originalUrl?: string; url?: string }> {
  const appOptions: CorsOptions = { origin: env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true };
  const waitlistOrigins = waitlistAllowedOrigins(env);
  const waitlistOptions: CorsOptions = {
    origin: waitlistOrigins,
    credentials: false,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    maxAge: 600,
  };
  return (req, callback) => callback(null, isWaitlistPath(req.originalUrl ?? req.url) ? waitlistOptions : appOptions);
}
