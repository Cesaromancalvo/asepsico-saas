import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { ACCESS_COOKIE } from './cookie.util';

function fromCookie(req: Request): string | null {
  return req?.cookies?.[ACCESS_COOKIE] ?? null;
}

const VALID_STAFF_ROLES = new Set(['OWNER', 'ADMIN', 'THERAPIST', 'ASSISTANT']);

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      // Prioriza la cookie httpOnly (flujo normal del navegador); permite Bearer como
      // alternativa para integraciones/servidor a servidor (p.ej. probar la API desde Swagger).
      jwtFromRequest: ExtractJwt.fromExtractors([fromCookie, ExtractJwt.fromAuthHeaderAsBearerToken()]),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET ?? 'development-only-secret-change-me',
    });
  }

  validate(payload: unknown) {
    // Rechazo explícito por forma, no solo por firma. Aunque el token esté correctamente
    // firmado (p.ej. si algún día se compartiera secreto por error con otro dominio de
    // confianza como el portal del paciente), un token de staff genuino SIEMPRE tiene
    // sub/workspaceId/role y NUNCA lleva "kind" (eso es exclusivo de otros tipos de token).
    if (
      typeof payload !== 'object' ||
      payload === null ||
      'kind' in payload ||
      typeof (payload as Record<string, unknown>).sub !== 'string' ||
      typeof (payload as Record<string, unknown>).workspaceId !== 'string' ||
      !VALID_STAFF_ROLES.has((payload as Record<string, unknown>).role as string)
    ) {
      throw new UnauthorizedException('Token no válido para este dominio');
    }
    return payload;
  }
}

