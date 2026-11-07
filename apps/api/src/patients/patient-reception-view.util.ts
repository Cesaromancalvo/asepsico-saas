import { Prisma } from '@prisma/client';
import { projectSelect } from './patient-view.util';

/**
 * Vista de recepción (ASSISTANT, o cualquier rol que no sea OWNER/ADMIN/THERAPIST) de los procesos
 * clínicos en GET /patients y GET /patients/:id. Regla dura 2: ASSISTANT no accede a
 * ClinicalProcess, así que solo recibe lo imprescindible para dar citas:
 *
 *  - el id del proceso ACTIVO (dato de enlace: POST /sessions lo necesita para asociar la cita);
 *  - el profesional que lo lleva (con quién se da la cita);
 *  - `hasActiveProcess`, calculado en servidor.
 *
 * Ni estado, ni modalidad, ni frecuencia, ni fechas, ni recuento de sesiones del proceso, ni
 * recuento de procesos. El filtro `status: 'ACTIVE'` va en la propia consulta: los procesos
 * pausados, de alta o cerrados no llegan a cargarse y el estado nunca se lee ni se devuelve.
 * La decisión de rol falla en cerrado (ver isReceptionRole).
 */
export const RECEPTION_PROCESS_SELECT = {
  id: true,
  therapist: { select: { id: true, firstName: true, lastName: true } },
} as const satisfies Prisma.ClinicalProcessSelect;

type ReceptionProcessRow = Prisma.ClinicalProcessGetPayload<{ select: typeof RECEPTION_PROCESS_SELECT }>;
export type ReceptionProcess = ReceptionProcessRow & { hasActiveProcess: true };

/** Relación `clinicalProcesses` para recepción: solo procesos ACTIVOS del workspace. */
export function receptionProcessesSelect(workspaceId: string, take?: number) {
  return {
    where: { workspaceId, status: 'ACTIVE' },
    orderBy: { updatedAt: 'desc' },
    ...(take ? { take } : {}),
    select: RECEPTION_PROCESS_SELECT,
  } as const satisfies Prisma.Patient$clinicalProcessesArgs;
}

/**
 * Proyección (lista blanca) de un proceso para recepción. `hasActiveProcess` sale del filtro
 * ACTIVE de la consulta; como defensa en profundidad, si la fila trajera un estado distinto
 * (consulta futura sin el filtro) el proceso se descarta en lugar de devolverse.
 */
export function toReceptionProcess(row: unknown): ReceptionProcess | null {
  if (!row) return null;
  const status = (row as { status?: unknown }).status;
  if (status !== undefined && status !== 'ACTIVE') return null;
  return { ...projectSelect<ReceptionProcessRow>(row, RECEPTION_PROCESS_SELECT), hasActiveProcess: true };
}

/** Primer proceso activo proyectado para recepción (o null). */
export function firstReceptionProcess(rows: unknown[]): ReceptionProcess | null {
  for (const row of rows) {
    const process = toReceptionProcess(row);
    if (process) return process;
  }
  return null;
}

/**
 * Select de sesiones para recepción en GET /patients/:id: el mismo de la vista clínica pero sin
 * `clinicalProcessId`. Con él, recepción podría agrupar sus citas por proceso y deducir cuántos
 * procesos ha tenido el paciente (y que hay alguno cerrado), el recuento que no se le devuelve.
 */
export function receptionSessionSelect<T extends Prisma.SessionSelect>(clinicalSelect: T): Omit<T, 'clinicalProcessId'> {
  const { clinicalProcessId: _omitted, ...rest } = clinicalSelect;
  return rest;
}
