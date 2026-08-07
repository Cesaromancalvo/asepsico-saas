import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class PortalGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const token = req.cookies?.portal_access_token;
    if (!token) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync(token);
      if (payload.kind !== 'patient_portal' || !payload.patientId || !payload.workspaceId) throw new Error('invalid');
      req.portalUser = payload;
      return true;
    } catch { throw new UnauthorizedException(); }
  }
}
