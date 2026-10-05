import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { NON_MODIFIABLE_STATUSES } from '../patients/patient-write.util';
import { ImportedValues, isMinor } from './row-validation';

export const IMPORTED_PROCESS_TITLE = 'Proceso importado';

/** Paciente + proceso mínimo a nombre del importador + vínculo con el lote + auditoría. */
export async function createImportedPatient(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  actor: AuthUser,
  jobId: string,
  rowNumber: number,
  values: ImportedValues,
) {
  const now = new Date();
  const discharged = values.status === 'DISCHARGED';
  const minor = values.birthDate !== null && isMinor(values.birthDate, now);
  const patient = await tx.patient.create({
    data: {
      workspaceId,
      firstName: values.firstName,
      lastName: values.lastName,
      email: values.email,
      phone: values.phone,
      birthDate: values.birthDate ? new Date(`${values.birthDate}T00:00:00.000Z`) : null,
      status: values.status,
      // Sin consultationReason ni ningún otro contenido clínico. No se crea ninguna cuenta de
      // portal. Menores: GUARDIAN_ONLY (el modo más restrictivo que existe; solo tutores) hasta
      // que el profesional complete tutores y decida el modo. Adultos: valor por defecto.
      ...(minor ? { portalAccessMode: 'GUARDIAN_ONLY' as const } : {}),
    },
    select: { id: true, portalAccessMode: true },
  });
  const process = await tx.clinicalProcess.create({
    data: {
      workspaceId,
      patientId: patient.id,
      therapistId: actor.sub,
      title: IMPORTED_PROCESS_TITLE,
      status: discharged ? 'CLOSED' : 'ACTIVE',
      startedAt: now,
      endedAt: discharged ? now : null,
    },
    select: { id: true },
  });
  await tx.patientImportItem.create({
    data: { workspaceId, jobId, patientId: patient.id, clinicalProcessId: process.id, rowNumber },
  });
  await tx.auditLog.create({
    data: {
      workspaceId,
      actorId: actor.sub,
      action: 'PATIENT_CREATED',
      entityType: 'Patient',
      entityId: patient.id,
      metadata: { source: 'IMPORT', importJobId: jobId, portalAccessMode: patient.portalAccessMode },
    },
  });
  await tx.auditLog.create({
    data: {
      workspaceId,
      actorId: actor.sub,
      action: 'CLINICAL_PROCESS_CREATED',
      entityType: 'ClinicalProcess',
      entityId: process.id,
      metadata: { patientId: patient.id, source: 'IMPORT', importJobId: jobId },
    },
  });
}

/**
 * "Completar el existente": rellena SOLO campos vacíos, nunca sobrescribe. Cada campo se escribe
 * con un UPDATE condicionado a que siga vacío (y a que el paciente siga siendo del importador y
 * modificable), así que ni una edición simultánea se pisa. Devuelve false si no rellenó nada.
 */
export async function completeExistingPatient(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  actor: AuthUser,
  jobId: string,
  patientId: string,
  values: ImportedValues,
): Promise<boolean> {
  const ownScope: Prisma.PatientWhereInput = {
    id: patientId,
    workspaceId,
    status: { notIn: [...NON_MODIFIABLE_STATUSES] },
    clinicalProcesses: { some: { workspaceId, therapistId: actor.sub } },
  };
  const candidates: Array<[keyof Pick<Prisma.PatientUpdateManyMutationInput, 'email' | 'phone' | 'birthDate'>, unknown]> = [
    ['email', values.email],
    ['phone', values.phone],
    ['birthDate', values.birthDate ? new Date(`${values.birthDate}T00:00:00.000Z`) : null],
  ];
  const filled: string[] = [];
  for (const [field, value] of candidates) {
    if (value === null || value === undefined) continue;
    const { count } = await tx.patient.updateMany({ where: { ...ownScope, [field]: null }, data: { [field]: value } });
    if (count > 0) filled.push(field);
  }
  if (filled.length === 0) return false;
  await tx.auditLog.create({
    data: {
      workspaceId,
      actorId: actor.sub,
      action: 'PATIENT_UPDATED',
      entityType: 'Patient',
      entityId: patientId,
      // Solo los NOMBRES de los campos rellenados, no sus valores.
      metadata: { source: 'IMPORT', importJobId: jobId, filledFields: filled },
    },
  });
  return true;
}
