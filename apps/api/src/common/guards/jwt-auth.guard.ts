import { ExecutionContext, ForbiddenException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../../database/prisma.service';
import { API_PREFIX, assertTermsAccepted, normalizeRequestPath } from '../../legal/terms-acceptance';

// Roles que deben tener el segundo factor activo para poder usar la aplicación, no solo
// para activarlo. ASSISTANT queda fuera a propósito: no toca contenido clínico.
const MFA_REQUIRED_ROLES = new Set(['OWNER', 'ADMIN', 'THERAPIST']);

/** Código del 403 cuando un rol que exige MFA aún no lo ha activado. */
export const MFA_SETUP_REQUIRED = 'MFA_SETUP_REQUIRED';

// Únicas rutas alcanzables sin tener aún el MFA activo: las necesarias para configurarlo,
// y cerrar sesión. Todo lo demás queda bloqueado hasta que el usuario lo active. Comparación
// EXACTA con la ruta normalizada completa bajo /api/v1 (mismo criterio que la C2 de Argos en
// terms-acceptance.ts): una ruta que solo termine igual (p. ej. /api/v1/patients/x/auth/logout)
// no queda exenta.
const MFA_SETUP_ALLOWED_PATHS: ReadonlySet<string> = new Set(
  ['/auth/mfa/setup', '/auth/mfa/confirm', '/auth/logout'].map((p) => `${API_PREFIX}${p}`),
);

export function isMfaSetupAllowedPath(path: string): boolean {
  return MFA_SETUP_ALLOWED_PATHS.has(normalizeRequestPath(path));
}

function requestPath(request: { originalUrl?: string; url?: string }): string {
  return (request.originalUrl ?? request.url ?? '').split('?')[0];
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  // PrismaService es global (DatabaseModule): el guard se resuelve en cualquier módulo.
  constructor(private readonly prisma?: PrismaService) {
    super();
  }

  /**
   * Tras autenticar (firma, expiración y MFA en handleRequest), comprueba que el profesional tiene
   * aceptadas las condiciones vigentes. Si no, 428 TERMS_ACCEPTANCE_REQUIRED (ver src/legal/).
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;
    if (!ok) return false;
    const request = context.switchToHttp().getRequest();
    // Falla cerrado: sin acceso a la BD no se puede saber si las condiciones están aceptadas.
    if (!this.prisma) throw new InternalServerErrorException('Configuración de autenticación incompleta');
    await assertTermsAccepted(this.prisma, request.user, requestPath(request));
    return true;
  }

  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    // Delega primero en el comportamiento estándar: valida firma/expiración del token y
    // lanza 401 si el token no es válido. Solo seguimos si la autenticación en sí ya fue bien.
    const authenticated = super.handleRequest(err, user, info, context);

    if (MFA_REQUIRED_ROLES.has(authenticated?.role) && authenticated?.mfaEnabled !== true) {
      const request = context.switchToHttp().getRequest();
      const path = requestPath(request);
      if (!isMfaSetupAllowedPath(path)) {
        // Mismo texto de siempre (compatibilidad) y un código estable para que la web no dependa del texto.
        throw new ForbiddenException({ statusCode: 403, code: MFA_SETUP_REQUIRED, message: 'Activa la verificación en dos pasos antes de continuar' });
      }
    }

    return authenticated;
  }
}
