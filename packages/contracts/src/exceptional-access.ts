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
