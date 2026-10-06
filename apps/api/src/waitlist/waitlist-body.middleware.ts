import { json, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

/** Límite de cuerpo de la ruta pública (el formulario completo ocupa < 2 KB). */
export const WAITLIST_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Parser propio de la ruta pública, montado en main.ts ANTES de los parsers globales de Nest
 * (100 KB): body-parser marca la petición como ya leída y el global no la vuelve a leer.
 *  - Cuerpo > 16 KB (por Content-Length o leyendo en streaming, también chunked) → 413.
 *  - Un POST que no sea application/json → 415 (así no lo lee el parser urlencoded global).
 *  - JSON mal formado → 400 genérico: el mensaje de JSON.parse puede citar el cuerpo recibido.
 * Las respuestas son JSON con la forma habitual de Nest y nunca repiten lo recibido.
 */
export function waitlistBodyParser(): RequestHandler {
  const parse = json({ limit: WAITLIST_BODY_LIMIT_BYTES, type: 'application/json' });
  const reply = (res: Response, statusCode: number, message: string) => res.status(statusCode).json({ statusCode, message });

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > WAITLIST_BODY_LIMIT_BYTES) return reply(res, 413, 'Payload Too Large');
    if (!req.is('application/json')) return reply(res, 415, 'Unsupported Media Type');
    parse(req, res, (error?: unknown) => {
      if (!error) return next();
      const status = (error as { status?: number; type?: string }).status;
      if (status === 413) return reply(res, 413, 'Payload Too Large');
      return reply(res, 400, 'Cuerpo JSON no válido');
    });
  };
}
