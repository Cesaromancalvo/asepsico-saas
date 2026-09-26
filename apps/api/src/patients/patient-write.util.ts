import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Condición de estado que debe seguir cumpliéndose en el momento de escribir. Se evalúa en el
 * propio UPDATE (compare-and-set), de modo que si otro proceso cambió el estado entre la
 * lectura/validación y la escritura, no se escribe nada.
 */
export type PatientStateGuard = Pick<Prisma.PatientWhereInput, 'status' | 'blockedAt'>;

/** Estados en los que el paciente no admite modificaciones ni archivado. */
export const NON_MODIFIABLE_STATUSES = ['ARCHIVED', 'BLOCKED'] as const;

/**
 * Escritura de un paciente acotada al workspace y protegida frente a carreras:
 * updateMany con { id, workspaceId, ...guard } (nunca solo por id).
 *
 * Si no se actualiza ninguna fila se relee SOLO con { id, workspaceId }:
 *  - no existe en este workspace → 404 (no se revela nada de otros workspaces);
 *  - existe pero ya no cumple el guard → 409 (el estado cambió entre la lectura y la escritura).
 * Cualquier excepción revierte la transacción en curso. Devuelve el registro actualizado.
 */
export async function updatePatientScoped(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  id: string,
  guard: PatientStateGuard,
  data: Prisma.PatientUpdateManyMutationInput,
) {
  const { count } = await tx.patient.updateMany({
    where: { id, workspaceId, ...guard },
    data,
  });

  const current = await tx.patient.findFirst({ where: { id, workspaceId } });
  if (!current) {
    throw new NotFoundException('Paciente no encontrado');
  }
  if (count === 0) {
    throw new ConflictException('El estado del paciente ha cambiado; recarga y vuelve a intentarlo');
  }
  return current;
}

/**
 * Alcance multi-tenant para modelos que cuelgan del paciente y NO tienen workspaceId propio
 * (TherapeuticTask, TherapyGoal, ClinicalAssessment, ClinicalHistory): el workspace se
 * comprueba a través de la relación patient, en el mismo WHERE de la escritura.
 */
export function patientChildScope(workspaceId: string, patientId: string) {
  return { patientId, patient: { workspaceId } };
}

/**
 * Comprueba el resultado de un updateMany/deleteMany acotado (id + workspace, nunca solo id).
 *
 * count === 0 significa que el registro ya no está en este workspace o que ya no cumple la
 * condición de estado incluida en el WHERE (compare-and-set). Si se pasa `stillExists`
 * (relectura acotada SIN la condición de estado) se distingue:
 *  - no existe en este workspace → 404 (no se revela nada de otros workspaces);
 *  - existe pero cambió de estado → 409.
 * Al lanzar dentro de prisma.$transaction no se confirma nada, auditoría incluida.
 */
export async function assertScopedWrite(
  count: number,
  notFoundMessage: string,
  stillExists?: () => Promise<unknown>,
): Promise<void> {
  if (count > 0) return;
  if (stillExists && (await stillExists())) {
    throw new ConflictException('El registro ha cambiado; recarga y vuelve a intentarlo');
  }
  throw new NotFoundException(notFoundMessage);
}
