import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { ClinicalAccessService } from '../clinical-access/clinical-access.service';

/**
 * Quién puede importar pacientes (spec, apartado 5): solo un profesional CLÍNICO del workspace,
 * decidido por el criterio central de E1 (ClinicalAccessService.isClinician): rol del token
 * distinto de ASSISTANT y perfil clínico según la BD (THERAPIST siempre; OWNER/ADMIN solo con
 * WorkspaceMember.isClinician; ASSISTANT nunca). Un OWNER/ADMIN no clínico recibe 403: la
 * importación crea procesos clínicos a nombre del importador y no tendría sentido (ni acceso)
 * para quien no trata pacientes. Todos los endpoints de importación pasan por assertCanImport().
 */
@Injectable()
export class PatientImportAccess {
  private readonly clinicalAccess: ClinicalAccessService;

  constructor(private readonly prisma: PrismaService) {
    // Sin estado: mismo patrón que PatientCoreService (instancia bajo demanda sobre el mismo Prisma).
    this.clinicalAccess = new ClinicalAccessService(prisma);
  }

  /** Lanza 403 (y lo audita) si el actor no es un profesional clínico de este workspace. */
  async assertCanImport(actor: AuthUser, operation: string): Promise<void> {
    assertStaffRole(actor);
    if (await this.clinicalAccess.isClinician(actor.workspaceId, actor)) return;
    await this.prisma.auditLog.create({
      data: {
        workspaceId: actor.workspaceId,
        actorId: actor.sub,
        action: 'PATIENT_IMPORT_FORBIDDEN',
        entityType: 'PatientImportJob',
        // Solo el rol y la operación intentada: ningún dato del fichero.
        metadata: { role: actor.role, operation },
      },
    });
    throw new ForbiddenException('Solo un profesional clínico puede importar pacientes');
  }
}
