import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Roles que deben tener el segundo factor activo para poder usar la aplicación, no solo
// para activarlo. ASSISTANT queda fuera a propósito: no toca contenido clínico.
const MFA_REQUIRED_ROLES = new Set(['OWNER', 'ADMIN', 'THERAPIST']);

// Únicas rutas alcanzables sin tener aún el MFA activo: las necesarias para configurarlo,
// y cerrar sesión. Todo lo demás queda bloqueado hasta que el usuario lo active.
const MFA_SETUP_ALLOWED_SUFFIXES = ['/auth/mfa/setup', '/auth/mfa/confirm', '/auth/logout'];

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    // Delega primero en el comportamiento estándar: valida firma/expiración del token y
    // lanza 401 si el token no es válido. Solo seguimos si la autenticación en sí ya fue bien.
    const authenticated = super.handleRequest(err, user, info, context);

    if (MFA_REQUIRED_ROLES.has(authenticated?.role) && authenticated?.mfaEnabled !== true) {
      const request = context.switchToHttp().getRequest();
      const path: string = (request.originalUrl ?? request.url ?? '').split('?')[0];
      const isSetupRelated = MFA_SETUP_ALLOWED_SUFFIXES.some((suffix) => path.endsWith(suffix));
      if (!isSetupRelated) {
        throw new ForbiddenException('Activa la verificación en dos pasos antes de continuar');
      }
    }

    return authenticated;
  }
}
