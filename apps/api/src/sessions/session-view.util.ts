import { Prisma } from '@prisma/client';
import { projectSelect } from '../patients/patient-view.util';

/**
 * Metadatos de una sesión para listados y vistas generales (agenda, listado de procesos...).
 *
 * NO incluye notes ni internalSummary: son narrativa clínica y los listados nunca la devuelven
 * (regla dura 2). Las notas solo se sirven en el detalle GET /sessions/:id y
 * GET /clinical-processes/:id.
 *
 * Si se añade un campo a Session, NO se expone por defecto: hay que añadirlo aquí a propósito.
 */
export const SESSION_SUMMARY_SELECT = {
  id: true,
  workspaceId: true,
  patientId: true,
  therapistId: true,
  clinicalProcessId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  type: true,
  location: true,
  videoCallUrl: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.SessionSelect;

/**
 * Fila de GET /sessions (agenda). El proceso clínico va sin título: el título puede revelar
 * contenido clínico y la agenda la usa también ASSISTANT; la web muestra estado · modalidad.
 */
export const SESSION_LIST_SELECT = {
  ...SESSION_SUMMARY_SELECT,
  patient: { select: { id: true, firstName: true, lastName: true } },
  therapist: { select: { id: true, firstName: true, lastName: true } },
  clinicalProcess: { select: { id: true, modality: true, status: true } },
} as const satisfies Prisma.SessionSelect;

const { clinicalProcessId: _receptionHiddenProcessId, ...SESSION_RECEPTION_SUMMARY } = SESSION_SUMMARY_SELECT;

/**
 * Cita tal como la RECIBE recepción (ASSISTANT), en listados (GET /sessions, también con
 * ?patientId=, y agenda del paciente) y en el detalle (GET /sessions/:id y respuestas de
 * POST/PATCH/reschedule/close, que reutilizan get). Regla dura 2: ASSISTANT no accede a
 * ClinicalProcess, así que no recibe la relación clinicalProcess (ni título, ni modalidad, ni
 * frecuencia, ni estado) NI el clinicalProcessId: solo el booleano hasClinicalProcess
 * (ver toReceptionSession) y los metadatos de agenda: cuándo, con quién, tipo, lugar y enlace.
 * Si la web necesita asociar una cita nueva al proceso activo, usa summary.activeProcess.id de
 * la ficha del paciente (que recepción sí recibe, solo del proceso ACTIVO).
 */
export const SESSION_RECEPTION_VIEW_SELECT = {
  ...SESSION_RECEPTION_SUMMARY,
  patient: { select: { id: true, firstName: true, lastName: true } },
  therapist: { select: { id: true, firstName: true, lastName: true } },
} as const satisfies Prisma.SessionSelect;

/**
 * Consulta de recepción: la vista anterior más clinicalProcessId, que se lee SOLO de forma interna
 * para calcular hasClinicalProcess. Prisma no permite derivar un booleano de una clave foránea en
 * el select (no hay campos calculados y _count solo existe en relaciones a-muchos), y la
 * alternativa (cargar la relación clinicalProcess) sería peor. El id nunca sale de
 * toReceptionSession: la respuesta se proyecta con SESSION_RECEPTION_VIEW_SELECT (lista blanca).
 * No usar este select para proyectar respuestas.
 */
export const SESSION_RECEPTION_SELECT = {
  ...SESSION_RECEPTION_VIEW_SELECT,
  clinicalProcessId: true,
} as const satisfies Prisma.SessionSelect;

type ReceptionQueryRow = Prisma.SessionGetPayload<{ select: typeof SESSION_RECEPTION_SELECT }>;
type ReceptionViewRow = Prisma.SessionGetPayload<{ select: typeof SESSION_RECEPTION_VIEW_SELECT }>;
export type ReceptionSessionView = ReceptionViewRow & { hasClinicalProcess: boolean };

/** Proyección de una fila de recepción: lista blanca sin clinicalProcessId + hasClinicalProcess. */
export function toReceptionSession(row: ReceptionQueryRow): ReceptionSessionView {
  return {
    ...projectSelect<ReceptionViewRow>(row, SESSION_RECEPTION_VIEW_SELECT),
    hasClinicalProcess: row.clinicalProcessId !== null && row.clinicalProcessId !== undefined,
  };
}

/** ASSISTANT (o cualquier rol no clínico) → vista de recepción, sin la relación clinicalProcess. */
export function isReceptionRole(role: string | undefined | null): boolean {
  return !['OWNER', 'ADMIN', 'THERAPIST'].includes(role ?? '');
}

/**
 * Detalle de sesión (GET /sessions/:id) para OWNER/ADMIN que no tratan al paciente: los mismos
 * metadatos que el listado, más la frecuencia del proceso. Sin notes, internalSummary ni título
 * del proceso. ASSISTANT usa SESSION_RECEPTION_SELECT.
 */
export const SESSION_ADMIN_DETAIL_SELECT = {
  ...SESSION_SUMMARY_SELECT,
  patient: { select: { id: true, firstName: true, lastName: true } },
  therapist: { select: { id: true, firstName: true, lastName: true } },
  clinicalProcess: { select: { id: true, modality: true, frequency: true, status: true } },
} as const satisfies Prisma.SessionSelect;

/**
 * Cita de OTRO profesional vista por un clínico que trata al paciente (agenda del paciente) o
 * listada en el 409 PROCESS_HAS_FUTURE_SESSIONS: solo cuándo y con quién (decisión del 02/10:
 * "solo fecha y hora"). Sin estado (nada de ausencias ni cancelaciones), notas, resumen, proceso
 * (ni título ni modalidad), tipo, lugar ni enlace de videollamada. Solo se usa para citas
 * SCHEDULED futuras: quien la lea sabe que es una cita programada.
 */
export const SESSION_BUSY_SELECT = {
  id: true,
  patientId: true,
  startsAt: true,
  endsAt: true,
  therapist: { select: { id: true, firstName: true, lastName: true } },
} as const satisfies Prisma.SessionSelect;
