import {
  CLINICAL_EXCEPTIONAL_REASONS,
  DEFERRABLE_NOTICE_REASONS,
  EXCEPTIONAL_ACCESS_REASONS,
  EXPORT_ALLOWED_EXCEPTIONAL_REASONS,
  OPENING_REASON_REQUIRED,
  PATIENT_HAS_FOREIGN_HISTORY,
  PROCESS_OPENING_REASONS,
  PROCESS_OPENING_REASON_LABELS,
  type CreateExceptionalAccessRequest,
  type ExceptionalAccessReasonCode,
  type ExceptionalAccessStatus,
  type JustificationReadPurpose,
  type ProcessOpeningReasonCode,
  type StaffRole,
} from '@asepsico/contracts';
import { ApiError } from './api';

/*
 * Acceso excepcional a la historia clínica y apertura de procesos sobre historia ajena (web).
 * Spec: docs/producto/acceso-excepcional.md (v4). La API decide siempre (ClinicalAccessService):
 * aquí solo hay textos, validación previa al envío y la interpretación de sus respuestas.
 */

export { EXCEPTIONAL_ACCESS_REASONS, PROCESS_OPENING_REASONS, PROCESS_OPENING_REASON_LABELS };
export type { ExceptionalAccessReasonCode, ProcessOpeningReasonCode };

/** Límites de la explicación (CreateExceptionalAccessDto: 20–300). */
export const JUSTIFICATION_MIN = 20;
export const JUSTIFICATION_MAX = 300;

/** Duración fija del acceso (§3.5). Solo para textos: la caducidad real la da `expiresAt`. */
export const EXCEPTIONAL_ACCESS_HOURS = 8;

/** Texto de cada motivo en el modal (§3.3, tal cual la spec). */
export const EXCEPTIONAL_REASON_OPTION_TEXT: Record<ExceptionalAccessReasonCode, string> = {
  CONTINUITY_OF_CARE: 'Voy a atender a este paciente de forma puntual (sustitución, derivación)',
  VITAL_URGENCY: 'Urgencia: riesgo grave e inmediato',
  PATIENT_RIGHTS_REQUEST: 'Atender una petición del paciente sobre sus datos',
  LEGAL_REQUIREMENT: 'Requerimiento de un juzgado, inspección u otra autoridad',
  CLAIM_DEFENCE: 'Reclamación o defensa jurídica',
  CUSTODY: 'Custodia de la historia (cese o fallecimiento del profesional)',
  DATA_INCIDENT: 'Corregir un error de datos o una incidencia',
};

/** Motivo "en lenguaje claro" para banda, registro e historial (mismo texto que el aviso de la API). */
export const EXCEPTIONAL_REASON_LABEL: Record<ExceptionalAccessReasonCode, string> = {
  CONTINUITY_OF_CARE: 'Atención puntual del paciente (sustitución, derivación)',
  VITAL_URGENCY: 'Urgencia: riesgo grave e inmediato',
  PATIENT_RIGHTS_REQUEST: 'Petición del paciente sobre sus datos',
  LEGAL_REQUIREMENT: 'Requerimiento de un juzgado, inspección u otra autoridad',
  CLAIM_DEFENCE: 'Reclamación o defensa jurídica',
  CUSTODY: 'Custodia de la historia',
  DATA_INCIDENT: 'Corrección de un error de datos o una incidencia',
};

export function exceptionalReasonLabel(code: string | null | undefined): string {
  return (code && EXCEPTIONAL_REASON_LABEL[code as ExceptionalAccessReasonCode]) || 'Motivo no indicado';
}

export function openingReasonLabel(code: string | null | undefined): string {
  return (code && PROCESS_OPENING_REASON_LABELS[code as ProcessOpeningReasonCode]) || 'Motivo no indicado';
}

export function isClinicalExceptionalReason(code: ExceptionalAccessReasonCode): boolean {
  return CLINICAL_EXCEPTIONAL_REASONS.includes(code);
}

/** ¿Este acceso permite exportar la historia completa (sin notas internas)? (§3.4, C5) */
export function exceptionalAllowsExport(code: string | null | undefined): boolean {
  return Boolean(code) && (EXPORT_ALLOWED_EXCEPTIONAL_REASONS as readonly string[]).includes(code as string);
}

/** Diferir el aviso al titular: solo OWNER y solo tres códigos (§3.6, CA3.4). */
export function canDeferNotice(role: StaffRole | null | undefined, code: ExceptionalAccessReasonCode | '' | null | undefined): boolean {
  return role === 'OWNER' && Boolean(code) && DEFERRABLE_NOTICE_REASONS.includes(code as ExceptionalAccessReasonCode);
}

/**
 * Motivos que se muestran en el modal, en el orden del catálogo. Los da la API
 * (`allowedReasons` de GET .../current: 7 con perfil clínico, 5 administrativos sin él); se
 * filtra contra el catálogo por si llegara un código desconocido. Nunca hay "Otro".
 */
export function visibleReasons(allowed: readonly string[] | null | undefined): ExceptionalAccessReasonCode[] {
  const set = new Set(allowed ?? []);
  return EXCEPTIONAL_ACCESS_REASONS.filter((code) => set.has(code));
}

export const JUSTIFICATION_EXAMPLES = [
  'Sustituyo a otra profesional durante su baja del 14 al 28/10.',
  'Requerimiento del Juzgado n.º 3, procedimiento 123/2026.',
  'Solicitud de acceso del paciente recibida el 10/10.',
];

export const CONFIRMATION_TEXT =
  'Confirmo que el motivo es cierto, que solo consultaré lo necesario para ese fin y que conozco mi deber de secreto (art. 16.6 de la Ley 41/2002).';

export const CLINICAL_TERMS_WARNING = 'CLINICAL_TERMS_WARNING';
export const EXCEPTIONAL_ACCESS_NOT_NEEDED = 'EXCEPTIONAL_ACCESS_NOT_NEEDED';
export const CLINICAL_TERMS_WARNING_TEXT = 'Parece que has incluido información clínica. Explica solo el motivo administrativo.';
export const REASON_MISS_TEXT = 'Entonces no abras la historia. Consulta con la dirección de la consulta.';

/* ------------------------------------------------------------------------------------------ */
/* Formulario del modal                                                                       */
/* ------------------------------------------------------------------------------------------ */

export type ExceptionalAccessForm = {
  reasonCode: ExceptionalAccessReasonCode | '';
  justification: string;
  confirmed: boolean;
  deferNotice: boolean;
  deferReason: string;
};

export const EMPTY_EXCEPTIONAL_FORM: ExceptionalAccessForm = { reasonCode: '', justification: '', confirmed: false, deferNotice: false, deferReason: '' };

export type ExceptionalFormField = 'reasonCode' | 'justification' | 'deferReason' | 'confirmed';
export type ExceptionalFormProblem = { field: ExceptionalFormField; message: string };

function lengthProblem(field: 'justification' | 'deferReason', value: string, what: string): ExceptionalFormProblem | null {
  const length = value.trim().length;
  if (length < JUSTIFICATION_MIN) return { field, message: `${what}: escribe al menos ${JUSTIFICATION_MIN} caracteres (llevas ${length}).` };
  if (length > JUSTIFICATION_MAX) return { field, message: `${what}: como máximo ${JUSTIFICATION_MAX} caracteres.` };
  return null;
}

/**
 * Primer problema del formulario (para enfocar ese campo) o null si se puede enviar. Mientras
 * haya alguno, [Abrir historia] está desactivado (CA1.4). La API vuelve a validarlo todo.
 */
export function validateExceptionalForm(
  form: ExceptionalAccessForm,
  allowed: readonly ExceptionalAccessReasonCode[],
  role: StaffRole | null | undefined,
): ExceptionalFormProblem | null {
  if (!form.reasonCode || !allowed.includes(form.reasonCode)) return { field: 'reasonCode', message: 'Elige el motivo de la lista.' };
  const justification = lengthProblem('justification', form.justification, 'Explicación');
  if (justification) return justification;
  if (form.deferNotice && canDeferNotice(role, form.reasonCode)) {
    const defer = lengthProblem('deferReason', form.deferReason, 'Motivo para diferir el aviso');
    if (defer) return defer;
  }
  if (!form.confirmed) return { field: 'confirmed', message: 'Marca la casilla de confirmación.' };
  return null;
}

/** Cuerpo de POST /patients/:id/exceptional-access. Solo envía el diferimiento si procede. */
export function buildExceptionalRequest(
  form: ExceptionalAccessForm,
  role: StaffRole | null | undefined,
  acknowledgedClinicalTerms = false,
): CreateExceptionalAccessRequest {
  if (!form.reasonCode) throw new Error('Falta el motivo');
  const defer = form.deferNotice && canDeferNotice(role, form.reasonCode);
  return {
    reasonCode: form.reasonCode,
    justification: form.justification.trim(),
    confirmed: true,
    ...(acknowledgedClinicalTerms ? { clinicalTermWarningAcknowledged: true } : {}),
    ...(defer ? { deferNotice: true, deferReason: form.deferReason.trim() } : {}),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Fechas y textos de la banda                                                                */
/* ------------------------------------------------------------------------------------------ */

export function formatHour(value: string | Date): string {
  return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

/** "hasta las 18:30" o, si caduca otro día, "hasta el 17/10/2026, 02:30". */
export function untilText(expiresAt: string, now: Date = new Date()): string {
  const end = new Date(expiresAt);
  const sameDay = end.toDateString() === now.toDateString();
  return sameDay ? `hasta las ${formatHour(end)}` : `hasta el ${formatDateTime(end)}`;
}

/** Minutos que quedan (0 si ya ha vencido). */
export function minutesLeft(expiresAt: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / 60_000));
}

export function remainingText(expiresAt: string, now: Date = new Date()): string {
  const minutes = minutesLeft(expiresAt, now);
  if (minutes <= 0) return 'ha vencido';
  if (minutes < 60) return `quedan ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `quedan ${hours} h ${rest} min` : `quedan ${hours} h`;
}

/** Duración de un acceso para el historial ("2 h 15 min"). */
export function durationText(from: string, to: string): string {
  const minutes = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/* ------------------------------------------------------------------------------------------ */
/* Registro del OWNER                                                                         */
/* ------------------------------------------------------------------------------------------ */

export const ACCESS_STATUS_LABEL: Record<ExceptionalAccessStatus, string> = {
  OPEN: 'Abierto',
  CLOSED: 'Cerrado',
  URGENCY_PENDING_REVIEW: 'Urgencia pendiente de revisión',
  NOTICE_DEFERRED: 'Aviso diferido',
  BLOCKED: 'Bloqueado',
};

/** Clase del chip de estado (sistema visual: status-pill). */
export const ACCESS_STATUS_TONE: Record<ExceptionalAccessStatus, string> = {
  OPEN: 'ready',
  CLOSED: 'manual',
  URGENCY_PENDING_REVIEW: 'warning',
  NOTICE_DEFERRED: 'warning',
  BLOCKED: 'blocked',
};

export const READ_PURPOSES: readonly JustificationReadPurpose[] = ['URGENCY_REVIEW', 'PATIENT_REQUEST', 'CLAIM_OR_AUTHORITY', 'INTERNAL_AUDIT'];
/** Paciente bloqueado: la explicación solo se lee por estos (CA4.6). */
export const BLOCKED_READ_PURPOSES: readonly JustificationReadPurpose[] = ['PATIENT_REQUEST', 'CLAIM_OR_AUTHORITY'];

export const READ_PURPOSE_LABEL: Record<JustificationReadPurpose, string> = {
  URGENCY_REVIEW: 'Revisar una urgencia',
  PATIENT_REQUEST: 'Atender una petición del paciente',
  CLAIM_OR_AUTHORITY: 'Reclamación o requerimiento de una autoridad',
  INTERNAL_AUDIT: 'Auditoría interna',
};

export function readPurposesFor(blocked: boolean): readonly JustificationReadPurpose[] {
  return blocked ? BLOCKED_READ_PURPOSES : READ_PURPOSES;
}

/** Plazo de la revisión de 72 h: "vence el 18/10/2026, 10:00" o "vencida". */
export function reviewDueText(dueAt: string | null, now: Date = new Date()): string | null {
  if (!dueAt) return null;
  return new Date(dueAt).getTime() < now.getTime() ? `Revisión vencida (${formatDateTime(dueAt)})` : `Revisar antes del ${formatDateTime(dueAt)}`;
}

/* ------------------------------------------------------------------------------------------ */
/* H6: abrir o reactivar un proceso sobre historia ajena                                      */
/* ------------------------------------------------------------------------------------------ */

export const FOREIGN_HISTORY_MESSAGE = 'Este paciente tiene historia con otro profesional. Pide a la dirección de la consulta que te abra el proceso.';
export const OPENING_REASON_INTRO = 'Este paciente tiene historia con otro profesional. Elige el motivo: quedará registrado y se avisará a los profesionales que lo atendieron.';

function errorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  return err.code ?? (typeof err.body.code === 'string' ? err.body.code : undefined);
}

/** 400 OPENING_REASON_REQUIRED: OWNER/ADMIN sin motivo de apertura → mostrar el selector. */
export function isOpeningReasonRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && errorCode(err) === OPENING_REASON_REQUIRED;
}

/** 403 PATIENT_HAS_FOREIGN_HISTORY: THERAPIST → se lo tiene que abrir la dirección. */
export function isForeignHistoryDenied(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && errorCode(err) === PATIENT_HAS_FOREIGN_HISTORY;
}

/** El usuario cerró el selector de motivo sin elegir: no es un error que haya que mostrar. */
export class OpeningCancelled extends Error {
  constructor() {
    super('Apertura cancelada');
    this.name = 'OpeningCancelled';
  }
}

/**
 * Ejecuta una apertura o reactivación. Primero sin motivo (el alta normal no lleva campos
 * nuevos, CA6.4); si la API pide motivo, pregunta (`ask`) y reintenta con él. Al THERAPIST
 * le traduce el 403 a un mensaje claro. Si el usuario cancela, lanza OpeningCancelled.
 */
export async function withOpeningReason<T>(
  call: (openingReasonCode?: ProcessOpeningReasonCode) => Promise<T>,
  ask: () => Promise<ProcessOpeningReasonCode | null>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (isForeignHistoryDenied(err)) throw new Error(FOREIGN_HISTORY_MESSAGE);
    if (!isOpeningReasonRequired(err)) throw err;
  }
  const code = await ask();
  if (!code) throw new OpeningCancelled();
  try {
    return await call(code);
  } catch (err) {
    if (isForeignHistoryDenied(err)) throw new Error(FOREIGN_HISTORY_MESSAGE);
    throw err;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Aviso en la app al titular (Notificaciones)                                                */
/* ------------------------------------------------------------------------------------------ */

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)\b/;

/**
 * La API escribe el aviso como "El 2026-10-16T08:30:00.000Z, Ana Ruiz (Titular) abrió la historia
 * de A. B. por: …". Se muestra como "El 16/10/2026 a las 10:30, …" en la hora local.
 */
export function formatClinicalAccessNotice(body: string): string {
  const match = ISO_DATE.exec(body);
  if (!match) return body;
  const date = new Date(match[1]);
  if (Number.isNaN(date.getTime())) return body;
  const day = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  return body.replace(`${match[1]},`, `${day} a las ${formatHour(date)},`).replace(match[1], `${day} a las ${formatHour(date)}`);
}
