// Contrato de la importación de pacientes (docs/producto/importacion-pacientes-csv.md).
// Base: /api/v1/patient-imports. Todas las rutas requieren sesión de staff y rol clínico.
// POST / responde 429 { code: 'IMPORT_BUSY' } si la consulta ya tiene otra subida en proceso.
//
// IMPORTANTE para la interfaz: "Completar el existente" (acción COMPLETE) NO se deshace con
// revert. Deshacer solo elimina los pacientes CREADOS por el lote; los datos que se rellenaron en
// pacientes existentes se quedan. Muéstralo al elegir COMPLETE y en el diálogo de deshacer.

/** Solo datos administrativos: no existe ningún campo clínico importable. */
export type PatientImportField = 'nombre' | 'apellidos' | 'email' | 'telefono' | 'prefijo' | 'fecha_nacimiento' | 'estado';
export type PatientImportColumnTarget = PatientImportField | 'NO_IMPORTAR';

export type PatientImportStatus =
  | 'UPLOADED' | 'PREVIEWED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'CANCELLED' | 'EXPIRED' | 'REVERTING' | 'REVERTED';

export interface PatientImportColumn {
  index: number;
  label: string;
  /** Cabecera potencialmente clínica: "No se importará", no se puede asignar. */
  clinical: boolean;
  /**
   * Columna no asignada en una vista previa anterior: sus datos se borraron del fichero temporal
   * (minimización) y no se puede asignar sin volver a subir el fichero.
   */
  discarded?: boolean;
  suggestedField: PatientImportColumnTarget;
}

/** POST /patient-imports (multipart, campo `file`; query opcional `sheet`). */
export interface PatientImportUploadResponse {
  id: string;
  format: 'CSV' | 'XLSX';
  sheetNames: string[];
  sheetIndex: number;
  /** Filas no vacías sin contar la primera (si es cabecera). */
  rowCount: number;
  columns: PatientImportColumn[];
  /** Hasta 5 filas (tras la primera) para ayudar a mapear. Columnas clínicas vacías. */
  sampleRows: Array<{ rowNumber: number; cells: string[] }>;
  expiresAt: string;
}

/** Cuerpo de POST /patient-imports/:id/preview. */
export interface PatientImportPreviewRequest {
  hasHeaderRow: boolean;
  columns: Array<{ index: number; field: PatientImportColumnTarget }>;
}

export type PatientImportIssueCode =
  | 'REQUIRED' | 'TOO_SHORT' | 'TOO_LONG' | 'INVALID_TEXT' | 'INVALID_EMAIL' | 'INVALID_PHONE' | 'INVALID_PREFIX'
  | 'INVALID_DATE' | 'IMPLAUSIBLE_DATE' | 'INVALID_STATUS' | 'AMBIGUOUS_DATE' | 'MINOR'
  // Solo en el informe de errores tras confirmar: la base de datos rechazó la fila (field = 'fila').
  | 'ROW_REJECTED';

// Códigos de rechazo del fichero en POST /patient-imports (cuerpo { code, message }).
export type PatientImportFileErrorCode =
  | 'FILE_REQUIRED' | 'FILE_TOO_LARGE' | 'TOO_MANY_ROWS' | 'TOO_MANY_COLUMNS' | 'LEGACY_XLS' | 'UNSUPPORTED_FORMAT'
  | 'INVALID_CSV' | 'INVALID_XLSX' | 'XLSX_TOO_LARGE_UNCOMPRESSED' | 'SHEET_NOT_FOUND' | 'EMPTY_FILE' | 'UNSUPPORTED_ENCODING';

export interface PatientImportIssue {
  field: PatientImportField;
  code: PatientImportIssueCode;
  message: string;
}

export interface PatientImportPreviewRow {
  rowNumber: number;
  status: 'VALID' | 'ERROR' | 'DUPLICATE' | 'IGNORED';
  ignoredReason?: 'EXAMPLE' | 'EMPTY';
  values: {
    firstName?: string;
    lastName?: string;
    email?: string | null;
    phone?: string | null;
    birthDate?: string | null; // aaaa-mm-dd
    status?: 'ACTIVE' | 'DISCHARGED';
  };
  errors: PatientImportIssue[];
  /**
   * AMBIGUOUS_DATE, MINOR. Un menor se crea con portalAccessMode GUARDIAN_ONLY (solo tutores);
   * el profesional completa tutores y decide el modo después.
   */
  warnings: PatientImportIssue[];
  duplicate?: {
    source: 'EXISTING' | 'FILE';
    rule: 'EMAIL' | 'PHONE' | 'NAME_BIRTHDATE';
    /** Solo pacientes del propio importador. */
    patientId?: string;
    row?: number;
    /** Si false, "Completar el existente" no está disponible. */
    canComplete: boolean;
  };
}

export interface PatientImportPreviewResponse {
  id: string;
  status: PatientImportStatus;
  hasHeaderRow: boolean;
  columns: Array<PatientImportColumn & { field: PatientImportColumnTarget }>;
  summary: { total: number; valid: number; errors: number; duplicates: number; ignored: number };
  rows: PatientImportPreviewRow[];
  expiresAt: string | null;
}

/**
 * Cuerpo de POST /patient-imports/:id/confirm. Filas duplicadas sin decisión → SKIP.
 * COMPLETE rellena solo campos vacíos del paciente existente y NO se deshace con revert.
 */
export interface PatientImportConfirmRequest {
  decisions?: Array<{ row: number; action: PatientImportDuplicateAction }>;
}

export type PatientImportDuplicateAction = 'SKIP' | 'CREATE' | 'COMPLETE';

/** GET /patient-imports/:id, GET /patient-imports (array), y respuesta de confirm/cancel/revert. */
export interface PatientImportJob {
  id: string;
  status: PatientImportStatus;
  format: 'CSV' | 'XLSX';
  totalRows: number;
  /** Filas del plan (a crear o completar) y cuántas se han procesado ya. */
  plannedRows: number;
  processedRows: number;
  createdCount: number;
  /** Pacientes existentes completados (COMPLETE). No se revierten con revert. */
  completedCount: number;
  skippedCount: number;
  errorCount: number;
  revertedCount: number;
  createdAt: string;
  confirmedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  revertibleUntil: string | null;
  revertedAt: string | null;
  /** PARTIAL con el fichero aún disponible: se puede volver a llamar a confirm (reanuda). */
  canRetry: boolean;
  canRevert: boolean;
  /**
   * Solo en la respuesta de revert: filas de pacientes CREADOS que no se eliminaron por tener
   * actividad. Las filas completadas (COMPLETE) no aparecen: nunca se revierten.
   */
  notRevertedRows?: number[];
}
