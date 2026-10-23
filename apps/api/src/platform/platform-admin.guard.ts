import { CanActivate, ExecutionContext, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../database/prisma.service';
import { isPlatformAdmin } from './platform-admin.config';
import { PLATFORM_AUDIT_ACTIONS, writePlatformAudit } from './platform-audit';

/** El mismo 404 que da Nest para una ruta que no existe: no revela que el panel existe. */
export function platformNotFound(path: string, method: string): NotFoundException {
  return new NotFoundException({ message: `Cannot ${method} ${path}`, error: 'Not Found', statusCode: 404 });
}

/**
 * Guard de la capacidad PLATFORM_ADMIN. Hace él mismo la autenticación normal (JwtAuthGuard) para
 * que CUALQUIER fallo de acceso (sin sesión, sesión revocada, condiciones pendientes, MFA sin
 * configurar, no admin, MFA desactivado, variable vacía) acabe en el mismo 404, sin pistas.
 *
 * No reutiliza ni relaja WorkspaceGuard/roles: no mira el rol ni el workspace del token, y no
 * deja nada en la request que otros endpoints puedan usar. Va ANTES de CsrfGuard para que un no
 * admin vea 404 y no 403.
 *
 * Un usuario autenticado que no es PLATFORM_ADMIN deja PLATFORM_ACCESS_DENIED (solo actorId).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger('PlatformAdmin');
  private readonly jwt: JwtAuthGuard;

  constructor(private readonly prisma: PrismaService) {
    this.jwt = new JwtAuthGuard(prisma);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const notFound = () => platformNotFound((request.originalUrl ?? request.url ?? '').split('?')[0], request.method);

    let authenticated = false;
    try {
      authenticated = (await this.jwt.canActivate(context)) === true;
    } catch (error) {
      // Errores de acceso (4xx) → 404. Un fallo interno (BD caída) sigue siendo un 5xx.
      if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
    }
    if (!authenticated) throw notFound();

    if (!(await isPlatformAdmin(this.prisma, request.user))) {
      try {
        await writePlatformAudit(this.prisma, {
          actorId: typeof request.user?.sub === 'string' ? request.user.sub : null,
          action: PLATFORM_AUDIT_ACTIONS.ACCESS_DENIED,
          entityType: 'PlatformAdmin',
          metadata: {},
        });
      } catch {
        this.logger.warn('No se pudo auditar un acceso denegado al panel de plataforma');
      }
      throw notFound();
    }
    return true;
  }
}
