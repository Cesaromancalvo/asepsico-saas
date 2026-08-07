import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { CSRF_COOKIE } from '../../auth/cookie.util';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Como la sesión ahora vive en cookies httpOnly, un sitio malicioso podría hacer que el
 * navegador del usuario envíe peticiones autenticadas sin querer (CSRF). Este guard exige
 * que el cliente reenvíe, como header, el valor de una cookie no-httpOnly (csrf_token):
 * solo JavaScript que corre en el propio origen puede leer esa cookie, así que un sitio
 * externo no puede adivinar el valor a reenviar.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.header('x-csrf-token');
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      throw new ForbiddenException('Token CSRF inválido o ausente');
    }
    return true;
  }
}
