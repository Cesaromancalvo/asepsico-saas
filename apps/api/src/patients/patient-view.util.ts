import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Vista general (administrativa) del paciente: lo único que devuelven las respuestas de
 * Patients (listado, detalle, alta, modificación y ciclo de vida).
 *
 * NO incluye consultationReason: es contenido clínico narrativo y un ASSISTANT tiene acceso a
 * estas respuestas. El motivo de consulta del paciente solo se sirve desde
 * GET /patients/:id/consultation-reason, que exige acceso clínico (assertPatientClinicalAccess).
 *
 * Si se añade un campo a Patient, NO se expone por defecto: hay que añadirlo aquí a propósito.
 */
export const PATIENT_VIEW_SELECT = {
  id: true,
  workspaceId: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  birthDate: true,
  status: true,
  portalAccessMode: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  blockedAt: true,
  retentionUntil: true,
} as const satisfies Prisma.PatientSelect;

export type PatientView = Prisma.PatientGetPayload<{ select: typeof PATIENT_VIEW_SELECT }>;

/**
 * Proyección explícita (lista blanca) de una fila según un `select` de Prisma: solo sobreviven
 * las claves marcadas con `true` y, en relaciones con `{ select }`, se aplica recursivamente
 * (a objetos y a arrays). Se aplica ADEMÁS del `select` de la consulta como defensa en
 * profundidad: aunque una consulta futura traiga la fila completa (include, relectura de
 * updatePatientScoped...), la respuesta nunca lleva campos que no estén en la lista blanca.
 */
export function projectSelect<T = any>(row: unknown, select: Record<string, any>): T {
  if (row === null || row === undefined) return row as T;
  if (Array.isArray(row)) return row.map((item) => projectSelect(item, select)) as T;
  const source = row as Record<string, any>;
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(select)) {
    if (!(key in source) || !rule) continue;
    out[key] = rule === true ? source[key] : rule.select ? projectSelect(source[key], rule.select) : source[key];
  }
  return out as T;
}

/** Vista general de un paciente a partir de cualquier fila (ver PATIENT_VIEW_SELECT). */
export function toPatientView(row: Record<string, any>): PatientView {
  return projectSelect<PatientView>(row, PATIENT_VIEW_SELECT);
}

const CLINICAL_ROLES = ['OWNER', 'ADMIN', 'THERAPIST'];

/**
 * Primera barrera (síncrona, por rol) para escribir el motivo de consulta en POST/PATCH /patients:
 * un ASSISTANT (o un rol desconocido) que lo envíe → 403, sin escribir nada. Después,
 * PatientCoreService exige además ser clínico (alta) o tratar al paciente (modificación).
 */
export function assertCanWriteConsultationReason(actor: AuthUser, dto: { consultationReason?: unknown }) {
  if (dto.consultationReason !== undefined && !CLINICAL_ROLES.includes(actor.role)) {
    throw new ForbiddenException('No tienes permiso para registrar el motivo de consulta');
  }
}
