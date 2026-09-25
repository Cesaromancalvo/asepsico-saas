import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { isAccessorAllowed } from './portal-access-mode.util';

const VALID_ACCESSOR_TYPES = new Set(['PATIENT', 'GUARDIAN']);

@Injectable()
export class PortalGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const token = req.cookies?.portal_access_token;
    if (!token) throw new UnauthorizedException();

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch { throw new UnauthorizedException(); }
    if (
      payload?.kind !== 'patient_portal' ||
      !payload.portalAccountId ||
      !payload.patientId ||
      !payload.workspaceId ||
      // El accessorType (paciente o tutor) es obligatorio desde el modelo de tutores:
      // un token antiguo sin este campo, o con un valor inesperado, se rechaza.
      !VALID_ACCESSOR_TYPES.has(payload.accessorType)
    ) {
      throw new UnauthorizedException();
    }

    // El JWT dura 30 min: sin esta comprobación, una cuenta revocada (baja manual o cambio de
    // portalAccessMode) seguiría leyendo y escribiendo hasta que caducara el token. Se exige en
    // cada petición: cuenta activa del mismo paciente y workspace, paciente no borrado y tipo de
    // cuenta admitido por el modo de acceso actual del paciente.
    const account = await (this.prisma as any).patientPortalAccount.findFirst({
      where: { id: payload.portalAccountId, patientId: payload.patientId, workspaceId: payload.workspaceId, isActive: true },
      select: { accessorType: true, patient: { select: { workspaceId: true, deletedAt: true, portalAccessMode: true } } },
    });
    if (
      !account ||
      account.accessorType !== payload.accessorType ||
      !account.patient ||
      account.patient.workspaceId !== payload.workspaceId ||
      account.patient.deletedAt ||
      !isAccessorAllowed(account.patient.portalAccessMode, account.accessorType)
    ) {
      throw new UnauthorizedException();
    }

    req.portalUser = payload;
    return true;
  }
}
