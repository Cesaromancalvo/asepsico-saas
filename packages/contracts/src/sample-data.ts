/**
 * E1 · Espacio de prueba listo para mirar (piloto demo). Todos los endpoints son SOLO del OWNER del
 * espacio; cualquier otro rol recibe 403. Los datos de ejemplo son pacientes inventados (isDemo).
 */

/** GET /sample-data — estado de los datos de ejemplo del espacio (sin contenido clínico). */
export interface SampleDataStatusContract {
  /** true si al registrarse se cargaron los datos de ejemplo (aunque después se hayan borrado). */
  loaded: boolean;
  loadedAt: string | null;
  clearedAt: string | null;
  /** Pacientes de ejemplo que siguen en el espacio (0 tras borrarlos). */
  samplePatients: number;
  /** Paciente de prueba con acceso al portal, si sigue existiendo. Sin correo ni contraseña. */
  portalPatient: { patientId: string; firstName: string; lastName: string } | null;
}

/**
 * POST /sample-data/portal-access — genera una contraseña temporal NUEVA para el paciente de prueba
 * y la devuelve UNA sola vez (Cache-Control: no-store). La anterior deja de valer. El portal pedirá
 * cambiarla al entrar. Nunca se guarda en claro ni va a logs, correos o auditoría.
 * 404 SAMPLE_PORTAL_PATIENT_NOT_FOUND si ya no hay paciente de prueba con portal.
 */
export interface SamplePortalAccessContract {
  patientId: string;
  firstName: string;
  lastName: string;
  email: string;
  temporaryPassword: string;
  mustChangePassword: true;
}

/** POST /sample-data/clear — cuerpo obligatorio: confirmación explícita. */
export interface ClearSampleDataRequestContract { confirm: true; }

/**
 * Respuesta de POST /sample-data/clear. 409 SAMPLE_DATA_NOT_PURGEABLE si hay facturas emitidas
 * de pacientes de ejemplo (no se borra nada).
 */
export interface ClearSampleDataResultContract {
  clearedAt: string;
  deleted: { patients: number; sessions: number; processes: number };
}

export type SampleDataErrorCode = 'SAMPLE_DATA_NOT_PURGEABLE' | 'SAMPLE_PORTAL_PATIENT_NOT_FOUND';
