import { Prisma } from '@prisma/client';

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

/**
 * Detalle de sesión (GET /sessions/:id y respuestas de POST/PATCH) para roles NO clínicos
 * (ASSISTANT): los mismos metadatos que el listado, más la frecuencia del proceso. Sin notes,
 * internalSummary ni título del proceso.
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
