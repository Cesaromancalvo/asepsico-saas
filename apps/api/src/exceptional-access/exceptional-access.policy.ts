/**
 * Reglas de negocio del acceso excepcional y de la apertura de procesos sobre historia ajena
 * (docs/producto/acceso-excepcional.md). Todo lo que el Jefe puede ajustar sin rehacer el flujo
 * está AQUÍ, en funciones puras y pequeñas:
 *
 *  - §9.1 a ("titular" en D2) → `exceptionalReasonsFor`.
 *  - §9.1 b y c (quién revisa con varios OWNER) → `reviewPermission`.
 *  - Catálogos cerrados, duración de la ventana, conservación, códigos que permiten exportar y
 *    códigos con aviso diferible.
 *
 * Los servicios no repiten estas reglas: las importan.
 */

export const EXCEPTIONAL_ACCESS_REASONS = [
  'CONTINUITY_OF_CARE',
  'VITAL_URGENCY',
  'PATIENT_RIGHTS_REQUEST',
  'LEGAL_REQUIREMENT',
  'CLAIM_DEFENCE',
  'CUSTODY',
  'DATA_INCIDENT',
] as const;
export type ExceptionalAccessReasonCode = (typeof EXCEPTIONAL_ACCESS_REASONS)[number];

/** Códigos clínicos: solo para OWNER/ADMIN con perfil clínico. */
export const CLINICAL_EXCEPTIONAL_REASONS: readonly ExceptionalAccessReasonCode[] = ['CONTINUITY_OF_CARE', 'VITAL_URGENCY'];
export const ADMINISTRATIVE_EXCEPTIONAL_REASONS: readonly ExceptionalAccessReasonCode[] =
  EXCEPTIONAL_ACCESS_REASONS.filter((code) => !CLINICAL_EXCEPTIONAL_REASONS.includes(code));

/** Con acceso EXCEPTIONAL, la exportación completa del paciente solo con estos códigos (C5). */
export const EXPORT_ALLOWED_REASONS: readonly ExceptionalAccessReasonCode[] = ['PATIENT_RIGHTS_REQUEST', 'LEGAL_REQUIREMENT', 'CLAIM_DEFENCE'];

/** Códigos en los que un OWNER puede diferir el aviso al titular (§3.6). */
export const DEFERRABLE_NOTICE_REASONS: readonly ExceptionalAccessReasonCode[] = ['LEGAL_REQUIREMENT', 'CLAIM_DEFENCE', 'DATA_INCIDENT'];

/** Códigos que entran en la revisión del OWNER en 72 h. */
export const OWNER_REVIEW_REASONS: readonly ExceptionalAccessReasonCode[] = ['VITAL_URGENCY'];

export const EXCEPTIONAL_ACCESS_REASON_LABELS: Record<ExceptionalAccessReasonCode, string> = {
  CONTINUITY_OF_CARE: 'Atención puntual del paciente (sustitución, derivación)',
  VITAL_URGENCY: 'Urgencia: riesgo grave e inmediato',
  PATIENT_RIGHTS_REQUEST: 'Petición del paciente sobre sus datos',
  LEGAL_REQUIREMENT: 'Requerimiento de un juzgado, inspección u otra autoridad',
  CLAIM_DEFENCE: 'Reclamación o defensa jurídica',
  CUSTODY: 'Custodia de la historia',
  DATA_INCIDENT: 'Corrección de un error de datos o una incidencia',
};

export const PROCESS_OPENING_REASONS = ['SUBSTITUTION', 'TRANSFER_ON_LEAVE', 'PATIENT_REQUESTED_CHANGE', 'REFERRAL'] as const;
export type ProcessOpeningReasonCode = (typeof PROCESS_OPENING_REASONS)[number];

export const PROCESS_OPENING_REASON_LABELS: Record<ProcessOpeningReasonCode, string> = {
  SUBSTITUTION: 'Sustitución de otro profesional',
  TRANSFER_ON_LEAVE: 'Traspaso por baja o salida del profesional',
  PATIENT_REQUESTED_CHANGE: 'El paciente ha pedido cambiar de profesional',
  REFERRAL: 'Derivación dentro de la consulta',
};

export function isProcessOpeningReason(value: unknown): value is ProcessOpeningReasonCode {
  return typeof value === 'string' && (PROCESS_OPENING_REASONS as readonly string[]).includes(value);
}

export function isExceptionalAccessReason(value: unknown): value is ExceptionalAccessReasonCode {
  return typeof value === 'string' && (EXCEPTIONAL_ACCESS_REASONS as readonly string[]).includes(value);
}

// --- Plazos ---------------------------------------------------------------------------------

export const EXCEPTIONAL_ACCESS_WINDOW_MS = 8 * 60 * 60 * 1000;
export const OWNER_REVIEW_WINDOW_MS = 72 * 60 * 60 * 1000;
export const DEFERRED_NOTICE_REMINDER_MS = 30 * 24 * 60 * 60 * 1000;
export const JUSTIFICATION_RETENTION_YEARS = 5;

export function retentionUntil(createdAt: Date): Date {
  const out = new Date(createdAt);
  out.setUTCFullYear(out.getUTCFullYear() + JUSTIFICATION_RETENTION_YEARS);
  return out;
}

// --- §9.1 punto 1: quién puede pedir acceso y con qué códigos ------------------------------

export interface RequesterProfile { role: string; isClinician: boolean }

/**
 * Códigos que puede usar quien pide un acceso excepcional. Lista vacía = no puede pedirlo.
 *
 * Decisión del Jefe (15/10, §9.1 a): "titular sin perfil clínico" = CUALQUIER OWNER/ADMIN sin
 * perfil clínico → 5 administrativos. Con perfil clínico → los 7. THERAPIST y ASSISTANT, ninguno.
 */
export function exceptionalReasonsFor(profile: RequesterProfile): readonly ExceptionalAccessReasonCode[] {
  if (profile.role !== 'OWNER' && profile.role !== 'ADMIN') return [];
  return profile.isClinician ? EXCEPTIONAL_ACCESS_REASONS : ADMINISTRATIVE_EXCEPTIONAL_REASONS;
}

// --- §9.1 punto 2: quién revisa (C4) -------------------------------------------------------

export interface ReviewableRecord { actorId: string; ownerCountAtCreation: number }

export type ReviewPermission =
  | { allowed: true; selfReview: boolean; /** Autorrevisión porque solo queda quien accedió (caso c). */ lastOwnerStanding: boolean }
  | { allowed: false };

/**
 * ¿Puede este OWNER marcar como revisado el acceso o la autoapertura? (C4, decisiones del Jefe
 * del 15/10 sobre §9.1):
 *  (a) [ver `exceptionalReasonsFor`].
 *  (b) Si al crear el registro había VARIOS OWNER, nadie revisa lo suyo: revisa otro OWNER.
 *  (c) Excepción: si los demás OWNER se han ido y quien accedió es el ÚNICO OWNER actual, se lo
 *      revisa él mismo (selfReview = true, lastOwnerStanding = true; queda auditado).
 *  Si al crearlo había un único OWNER, se revisa a sí mismo aunque después entren más.
 * `currentOwnerIds` = OWNER del workspace en el momento de revisar (leídos de la BD).
 */
export function reviewPermission(record: ReviewableRecord, reviewerId: string, currentOwnerIds: readonly string[]): ReviewPermission {
  if (!currentOwnerIds.includes(reviewerId)) return { allowed: false };
  if (record.actorId !== reviewerId) return { allowed: true, selfReview: false, lastOwnerStanding: false };
  if (record.ownerCountAtCreation <= 1) return { allowed: true, selfReview: true, lastOwnerStanding: false };
  if (currentOwnerIds.length === 1) return { allowed: true, selfReview: true, lastOwnerStanding: true };
  return { allowed: false };
}

// --- Aviso de términos clínicos (avisa, no bloquea) ----------------------------------------

/** Lista corta del §3.3. Solo marca el aviso; nunca bloquea ni guarda qué término salió. */
export const CLINICAL_TERM_HINTS = ['diagnóstic', 'diagnostic', 'ansiedad', 'depresi', 'medicaci', 'suicid', 'psicosis', 'trastorno', 'síntoma', 'sintoma'];

export function containsClinicalTerms(text: string): boolean {
  const normalized = text.toLowerCase();
  return CLINICAL_TERM_HINTS.some((term) => normalized.includes(term));
}

// --- Textos de aviso --------------------------------------------------------------------------

export const ROLE_LABELS: Record<string, string> = { OWNER: 'Titular', ADMIN: 'Administración', THERAPIST: 'Terapeuta', ASSISTANT: 'Asistente' };

export function patientInitials(patient: { firstName?: string | null; lastName?: string | null }): string {
  const first = (patient.firstName ?? '').trim().charAt(0);
  const last = (patient.lastName ?? '').trim().charAt(0);
  const initials = `${first}${last}`.toUpperCase();
  return initials ? initials.split('').join('. ') + '.' : 'el paciente';
}
