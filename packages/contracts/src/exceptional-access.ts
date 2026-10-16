/**
 * Acceso excepcional a la historia clínica y apertura de procesos sobre historia ajena.
 * Spec: docs/producto/acceso-excepcional.md. Copia de los catálogos de
 * apps/api/src/exceptional-access/exceptional-access.policy.ts (mantener sincronizados).
 */

// --- H6: apertura o reactivación de procesos sobre historia ajena ---------------------------

export const PROCESS_OPENING_REASONS = ['SUBSTITUTION', 'TRANSFER_ON_LEAVE', 'PATIENT_REQUESTED_CHANGE', 'REFERRAL'] as const;
export type ProcessOpeningReasonCode = (typeof PROCESS_OPENING_REASONS)[number];

export const PROCESS_OPENING_REASON_LABELS: Record<ProcessOpeningReasonCode, string> = {
  SUBSTITUTION: 'Sustitución de otro profesional',
  TRANSFER_ON_LEAVE: 'Traspaso por baja o salida del profesional',
  PATIENT_REQUESTED_CHANGE: 'El paciente ha pedido cambiar de profesional',
  REFERRAL: 'Derivación dentro de la consulta',
};

/**
 * 400 de POST /clinical-processes y PATCH /clinical-processes/:id/status (a ACTIVE) cuando el
 * paciente tiene historia con otro profesional y falta `openingReasonCode` (solo OWNER/ADMIN).
 * La web muestra entonces el selector de motivo y reintenta con el código.
 */
export const OPENING_REASON_REQUIRED = 'OPENING_REASON_REQUIRED';
/** 403 para THERAPIST: "Pide a la dirección de la consulta que te abra el proceso". Auditado. */
export const PATIENT_HAS_FOREIGN_HISTORY = 'PATIENT_HAS_FOREIGN_HISTORY';

export interface OpeningReasonRequiredError { statusCode: 400; error: 'Bad Request'; code: typeof OPENING_REASON_REQUIRED; message: string }
export interface PatientHasForeignHistoryError { statusCode: 403; error: 'Forbidden'; code: typeof PATIENT_HAS_FOREIGN_HISTORY; message: string }

/** Campo opcional añadido a POST /clinical-processes y PATCH /clinical-processes/:id/status. */
export interface ProcessOpeningReasonField { openingReasonCode?: ProcessOpeningReasonCode }

// --- H1–H4: acceso excepcional -------------------------------------------------------------

export const EXCEPTIONAL_ACCESS_REASONS = ['CONTINUITY_OF_CARE', 'VITAL_URGENCY', 'PATIENT_RIGHTS_REQUEST', 'LEGAL_REQUIREMENT', 'CLAIM_DEFENCE', 'CUSTODY', 'DATA_INCIDENT'] as const;
export type ExceptionalAccessReasonCode = (typeof EXCEPTIONAL_ACCESS_REASONS)[number];
/** Solo OWNER/ADMIN con perfil clínico. Sin perfil clínico (OWNER o ADMIN): los 5 restantes. */
export const CLINICAL_EXCEPTIONAL_REASONS: readonly ExceptionalAccessReasonCode[] = ['CONTINUITY_OF_CARE', 'VITAL_URGENCY'];
/** Con acceso excepcional, la exportación completa del paciente solo con estos (sin notas internas). */
export const EXPORT_ALLOWED_EXCEPTIONAL_REASONS: readonly ExceptionalAccessReasonCode[] = ['PATIENT_RIGHTS_REQUEST', 'LEGAL_REQUIREMENT', 'CLAIM_DEFENCE'];
/** Solo el OWNER puede diferir el aviso al titular, y solo con estos. */
export const DEFERRABLE_NOTICE_REASONS: readonly ExceptionalAccessReasonCode[] = ['LEGAL_REQUIREMENT', 'CLAIM_DEFENCE', 'DATA_INCIDENT'];

/** POST /patients/:patientId/exceptional-access (JWT + CSRF). OWNER/ADMIN. */
export interface CreateExceptionalAccessRequest {
  reasonCode: ExceptionalAccessReasonCode;
  /** 20–300 caracteres. Porqué administrativo, nunca clínico: el paciente puede leerlo. */
  justification: string;
  confirmed: true;
  /** Reenviar a true tras el 400 CLINICAL_TERMS_WARNING si el usuario decide continuar. */
  clinicalTermWarningAcknowledged?: boolean;
  deferNotice?: boolean;
  /** 20–300 caracteres; obligatorio con deferNotice. */
  deferReason?: string;
}
export interface CreateExceptionalAccessResponse {
  id: string; reasonCode: ExceptionalAccessReasonCode; createdAt: string; expiresAt: string;
  ownerReviewDueAt: string | null; notificationDeferredAt: string | null; hoursValid: number; noticeDeferred: boolean;
}
/**
 * Errores con código: 400 CLINICAL_TERMS_WARNING (mostrar aviso; reenviar con acknowledged),
 * 409 EXCEPTIONAL_ACCESS_NOT_NEEDED (ya trata al paciente o ya tiene uno vigente),
 * 401 SESSION_REQUIRED (token sin sesión: refrescar). 403 sin código: rol o motivo no permitido.
 */
export type ExceptionalAccessErrorCode = 'CLINICAL_TERMS_WARNING' | 'EXCEPTIONAL_ACCESS_NOT_NEEDED' | 'SESSION_REQUIRED';

/** GET /patients/:patientId/exceptional-access/current: banda de la ficha y si mostrar el botón. */
export interface CurrentExceptionalAccessResponse {
  active: { id: string; reasonCode: ExceptionalAccessReasonCode; createdAt: string; expiresAt: string } | null;
  canRequest: boolean;
  /** Códigos que este usuario puede elegir (vacío: no ve el botón). */
  allowedReasons: ExceptionalAccessReasonCode[];
}
// POST /patients/:patientId/exceptional-access/:accessId/close → { closed: true } (solo el propio).
// POST /exceptional-access/reason-miss → { counted: true } ("Mi motivo no está en la lista").

export type ExceptionalAccessStatus = 'OPEN' | 'CLOSED' | 'URGENCY_PENDING_REVIEW' | 'NOTICE_DEFERRED' | 'BLOCKED';
export type OwnerReviewOutcome = 'CORRECT' | 'INCIDENT';

/** GET /exceptional-access: OWNER todo el workspace; ADMIN solo lo suyo. Nunca texto. */
export interface ExceptionalAccessRegisterResponse {
  accesses: Array<{
    type: 'EXCEPTIONAL_ACCESS'; id: string; patientId: string; patientInitials: string | null; actorId: string; actorRole: 'OWNER' | 'ADMIN';
    reasonCode: ExceptionalAccessReasonCode; createdAt: string; expiresAt: string; closedAt: string | null; closeReason: string | null;
    ownerReviewDueAt: string | null; reviewedAt: string | null; reviewedById: string | null; reviewOutcome: OwnerReviewOutcome | null; selfReview: boolean | null;
    notificationDeferredAt: string | null; notificationReleasedAt: string | null; blockedAt: string | null; clinicalTermWarningIgnored: boolean;
    migratedFromAuditLogId: string | null; status: ExceptionalAccessStatus;
  }>;
  openings: Array<{
    type: 'PROCESS_OPENING_OVER_HISTORY'; id: string; patientId: string; patientInitials: string | null; clinicalProcessId: string; actorId: string;
    actorRole: 'OWNER' | 'ADMIN'; targetTherapistId: string; kind: 'OPENED' | 'REACTIVATED'; reasonCode: ProcessOpeningReasonCode; selfAssigned: boolean;
    ownerReviewDueAt: string | null; reviewedAt: string | null; reviewedById: string | null; reviewOutcome: OwnerReviewOutcome | null; selfReview: boolean | null;
    createdAt: string; pendingReview: boolean;
  }>;
}

export const JUSTIFICATION_READ_PURPOSES = ['URGENCY_REVIEW', 'PATIENT_REQUEST', 'CLAIM_OR_AUTHORITY', 'INTERNAL_AUDIT'] as const;
export type JustificationReadPurpose = (typeof JUSTIFICATION_READ_PURPOSES)[number];
/** POST /exceptional-access/:accessId/justification (solo OWNER; paciente bloqueado: PATIENT_REQUEST o CLAIM_OR_AUTHORITY). */
export interface ReadJustificationRequest { purpose: JustificationReadPurpose }
export interface ReadJustificationResponse { id: string; justification: string | null }

/**
 * POST /exceptional-access/:accessId/review y /exceptional-access/openings/:openingId/review (solo OWNER).
 * Decisiones del Jefe (15/10): con varios OWNER al crear, revisa otro; si solo queda quien accedió,
 * se revisa él (selfReview + lastOwnerStanding); con un único OWNER al crear, autorrevisión.
 */
export interface ReviewRequest { outcome: OwnerReviewOutcome }
export interface ReviewResponse { reviewed: true; selfReview: boolean; lastOwnerStanding: boolean }
// POST /exceptional-access/:accessId/release-notice (solo OWNER) → { released: true }.

/** GET /patients/:patientId/access-history: autores de procesos del paciente. Nunca texto. */
export interface PatientAccessHistoryResponse {
  accesses: Array<{ id: string; actorId: string; actorName: string | null; actorRole: 'OWNER' | 'ADMIN'; reasonCode: ExceptionalAccessReasonCode; createdAt: string; expiresAt: string; closedAt: string | null; endedAt: string }>;
  openings: Array<{ id: string; actorId: string; actorName: string | null; actorRole: 'OWNER' | 'ADMIN'; reasonCode: ProcessOpeningReasonCode; kind: 'OPENED' | 'REACTIVATED'; targetTherapistId: string; createdAt: string }>;
}
