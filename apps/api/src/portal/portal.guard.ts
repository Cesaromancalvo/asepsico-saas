import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const VALID_ACCESSOR_TYPES = new Set(['PATIENT', 'GUARDIAN']);

@Injectable()
export class PortalGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const token = req.cookies?.portal_access_token;
    if (!token) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync(token);
      if (
        payload.kind !== 'patient_portal' ||
        !payload.patientId ||
        !payload.workspaceId ||
        // El accessorType (paciente o tutor) es obligatorio desde el modelo de tutores:
        // un token antiguo sin este campo, o con un valor inesperado, se rechaza.
        !VALID_ACCESSOR_TYPES.has(payload.accessorType)
      ) {
        throw new Error('invalid');
      }
      req.portalUser = payload;
      return true;
    } catch { throw new UnauthorizedException(); }
  }
}
