import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';

/**
 * Criterio de rol clínico ACTUAL (el mismo que PatientAccessService.assertClinicalAccess).
 *
 * TODO(E1 acceso clínico): cuando se fusione feat/e1-acceso-clinico, sustituir este criterio por
 * el guard central de acceso clínico (WorkspaceMember.isClinician leído de base de datos), de
 * modo que un OWNER/ADMIN NO clínico reciba 403 como pide la spec (apartado 5). Hasta entonces
 * OWNER y ADMIN pueden importar (y los pacientes quedan a su nombre, igual que si abrieran un
 * proceso para sí mismos). Es el ÚNICO punto que hay que cambiar: todos los endpoints de
 * importación pasan por assertCanImport().
 */
export const IMPORT_CLINICAL_ROLES: readonly string[] = ['OWNER', 'ADMIN', 'THERAPIST'];

@Injectable()
export class PatientImportAccess {
  constructor(private readonly prisma: PrismaService) {}

  /** Lanza 403 (y lo audita) si el actor no es un profesional clínico. */
  async assertCanImport(actor: AuthUser, operation: string): Promise<void> {
    assertStaffRole(actor);
    if (IMPORT_CLINICAL_ROLES.includes(actor.role)) return;
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
