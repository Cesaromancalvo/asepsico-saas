import { Prisma } from '@prisma/client';

// Reglas de convivencia entre el modo de acceso al portal que decide el profesional para el
// paciente (Patient.portalAccessMode) y el tipo de cuenta de portal (accessorType).
//   PATIENT_ONLY  → solo el propio paciente.
//   GUARDIAN_ONLY → solo su(s) tutor(es).
//   SHARED        → ambos.
// Se centraliza aquí para que el alta de cuentas (PortalService.enable) y el cambio de modo
// (PatientCoreService.update) apliquen exactamente la misma regla.

export type PortalAccessModeValue = 'PATIENT_ONLY' | 'GUARDIAN_ONLY' | 'SHARED';
export type PortalAccessorTypeValue = 'PATIENT' | 'GUARDIAN';

const ALLOWED_ACCESSORS: Record<PortalAccessModeValue, readonly PortalAccessorTypeValue[]> = {
  PATIENT_ONLY: ['PATIENT'],
  GUARDIAN_ONLY: ['GUARDIAN'],
  SHARED: ['PATIENT', 'GUARDIAN'],
};

const ALL_ACCESSORS: readonly PortalAccessorTypeValue[] = ['PATIENT', 'GUARDIAN'];

// Lista blanca: un modo desconocido o vacío no admite a nadie.
export function isAccessorAllowed(mode: string | null | undefined, accessorType: string): boolean {
  const allowed = ALLOWED_ACCESSORS[mode as PortalAccessModeValue];
  return Boolean(allowed && allowed.includes(accessorType as PortalAccessorTypeValue));
}

export function incompatibleAccessorTypes(mode: string | null | undefined): PortalAccessorTypeValue[] {
  return ALL_ACCESSORS.filter((type) => !isAccessorAllowed(mode, type));
}

type PortalModeTx = Pick<Prisma.TransactionClient, 'patientPortalAccount' | 'auditLog'>;

/**
 * Se ejecuta DENTRO de la transacción que cambia Patient.portalAccessMode: desactiva las
 * cuentas activas que el nuevo modo ya no admite y lo audita. Si la auditoría falla, la
 * transacción entera (modo + revocación) se deshace.
 *
 * La metadata solo lleva modos e ids; nunca emails, nombres de tutor ni datos clínicos.
 */
export async function applyPortalAccessModeChange(
  tx: PortalModeTx,
  params: {
    workspaceId: string;
    actorId: string;
    patientId: string;
    previousMode: string | null | undefined;
    newMode: PortalAccessModeValue;
  },
): Promise<{ revokedAccountIds: string[] }> {
  const { workspaceId, actorId, patientId, previousMode, newMode } = params;
  const incompatible = incompatibleAccessorTypes(newMode);

  let revokedAccountIds: string[] = [];
  if (incompatible.length > 0) {
    const where = { workspaceId, patientId, isActive: true, accessorType: { in: incompatible } };
    const toRevoke = await tx.patientPortalAccount.findMany({ where, select: { id: true } });
    revokedAccountIds = toRevoke.map((account) => account.id);
    if (revokedAccountIds.length > 0) {
      await tx.patientPortalAccount.updateMany({
        where: { ...where, id: { in: revokedAccountIds } },
        data: { isActive: false },
      });
    }
  }

  // Se audita si el modo cambia o si, aun sin cambiar, se han limpiado cuentas incompatibles
  // que ya existían (datos heredados de antes de esta validación).
  if (previousMode !== newMode || revokedAccountIds.length > 0) {
    await tx.auditLog.create({
      data: {
        workspaceId,
        actorId,
        action: 'PATIENT_PORTAL_ACCESS_MODE_CHANGED',
        entityType: 'Patient',
        entityId: patientId,
        metadata: { previousMode: previousMode ?? null, newMode, revokedAccountIds },
      },
    });
  }

  return { revokedAccountIds };
}
