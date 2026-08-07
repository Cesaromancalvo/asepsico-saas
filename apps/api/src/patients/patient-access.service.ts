import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';

@Injectable()
export class PatientAccessService {
  constructor(private readonly prisma: PrismaService) {}

  assertClinicalAccess(actor: AuthUser) {
    if (!['OWNER', 'ADMIN', 'THERAPIST'].includes(actor.role)) {
      throw new ForbiddenException('No tienes acceso al contenido clínico');
    }
  }

  async assertPatientClinicalAccess(workspaceId: string, actor: AuthUser, patientId: string) {
    this.assertClinicalAccess(actor);
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    if (actor.role === 'THERAPIST') {
      const ownsProcess = await this.prisma.clinicalProcess.findFirst({
        where: { workspaceId, patientId, therapistId: actor.sub }, select: { id: true },
      });
      if (!ownsProcess) throw new ForbiddenException('Solo puedes acceder a pacientes con un proceso clínico asignado');
    }
    return patient;
  }
}
