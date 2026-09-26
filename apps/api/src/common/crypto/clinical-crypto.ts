import { decryptField, encryptField, isEncryptedValue } from './field-encryption';

/**
 * FUENTE ÚNICA de qué campos se cifran en reposo y de cómo se descifran.
 *
 * La usan los servicios (al escribir y al leer), la exportación (arts. 15/20 RGPD), el script
 * prisma/scripts/encrypt-plaintext-fields.ts (migración de datos en claro y rotación de clave)
 * y los tests de seguridad. Si añades un campo cifrado, añádelo AQUÍ: así el script lo migra,
 * la exportación lo descifra y el test tabla-driven exige que se escriba cifrado.
 *
 * Fuera de la lista a propósito (ver docs/SECURITY_BASELINE.md):
 *  - Patient.firstName/lastName/email/phone: se buscan y ordenan en BD.
 *  - ClinicalAssessment.totalScore/severity/riskFlag: pendiente de decisión (cambio de esquema).
 *  - Títulos de documentos, consentimientos, informes y procesos, y metadatos (fechas, estados).
 */

/** Los 10 campos narrativos de la historia clínica. */
export const CLINICAL_HISTORY_ENCRYPTED_FIELDS = [
  'reasonForConsultation',
  'currentProblem',
  'personalHistory',
  'familyHistory',
  'medicalHistory',
  'currentMedication',
  'primaryDiagnosis',
  'riskFactors',
  'protectiveFactors',
  'clinicalObservations',
] as const;

/** Campos de texto cifrados, por delegado de Prisma (nombre en camelCase). */
export const ENCRYPTED_TEXT_FIELDS = {
  patient: ['consultationReason'],
  clinicalHistory: CLINICAL_HISTORY_ENCRYPTED_FIELDS,
  therapyGoal: ['title', 'description'],
  therapeuticTask: ['title', 'instructions', 'clinicianNotes', 'reviewComment', 'patientFeedback'],
  therapeuticTaskTemplate: ['instructions'],
  clinicalProcess: ['consultationReason', 'goals', 'internalNotes'],
  session: ['notes', 'internalSummary'],
  clinicalAssessment: ['interpretation', 'clinicalNotes'],
  clinicalReport: ['content'],
  patientDocument: ['description', 'fileName'],
  consentRecord: ['notes'],
  message: ['body', 'attachmentName'],
  user: ['totpSecret'],
} as const;

/**
 * Campos Json cifrados: se serializan a JSON, se cifra ese texto y se guarda el string cifrado
 * dentro de la columna Json. Un valor que no sea string es un dato antiguo en claro.
 */
export const ENCRYPTED_JSON_FIELDS = {
  clinicalAssessment: ['answers'],
} as const;

export type EncryptedModel = keyof typeof ENCRYPTED_TEXT_FIELDS;

type Row = Record<string, any>;

/** Cifra, en una copia de `data`, los campos marcados del modelo que estén presentes. */
export function encryptModelData<T extends Row>(model: EncryptedModel, data: T): T {
  const out: Row = { ...data };
  for (const field of ENCRYPTED_TEXT_FIELDS[model] as readonly string[]) {
    if (field in out && (typeof out[field] === 'string' || out[field] === null)) out[field] = encryptField(out[field]);
  }
  return out as T;
}

/** Descifra, en una copia, los campos marcados del modelo que estén presentes (no añade claves). */
export function decryptModel<T extends Row>(model: EncryptedModel, row: T): T;
export function decryptModel<T extends Row>(model: EncryptedModel, row: T | null): T | null;
export function decryptModel<T extends Row>(model: EncryptedModel, row: T | null): T | null {
  if (!row) return row;
  const out: Row = { ...row };
  for (const field of ENCRYPTED_TEXT_FIELDS[model] as readonly string[]) {
    if (field in out && typeof out[field] === 'string') out[field] = decryptField(out[field]);
  }
  return out as T;
}

export function encryptJsonField(value: unknown): string {
  return encryptField(JSON.stringify(value))!;
}

export function decryptJsonField<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return (raw ?? fallback) as T; // dato antiguo sin cifrar
  try { return JSON.parse(decryptField(raw) ?? 'null') ?? fallback; } catch { return fallback; }
}

// ---- Helpers por modelo (mismo contrato que tenían en cada servicio) ----

export const decryptPatient = <T extends Row>(p: T): T => decryptModel('patient', p);
export const decryptClinicalHistory = <T extends Row>(h: T): T => decryptModel('clinicalHistory', h);
export const decryptTherapyGoal = <T extends Row>(g: T): T => decryptModel('therapyGoal', g);
export const decryptTaskTemplate = <T extends Row>(t: T): T => decryptModel('therapeuticTaskTemplate', t);
export const decryptProcess = <T extends Row>(p: T): T => decryptModel('clinicalProcess', p);
export const decryptSession = <T extends Row>(s: T): T => decryptModel('session', s);
export const decryptReport = <T extends Row>(r: T): T => decryptModel('clinicalReport', r);
export const decryptDocument = <T extends Row>(d: T): T => decryptModel('patientDocument', d);
export const decryptConsent = <T extends Row>(c: T): T => decryptModel('consentRecord', c);
export const decryptMessage = <T extends Row>(m: T): T => decryptModel('message', m);

/** Tarea terapéutica; si trae el objetivo enlazado (include therapyGoal), también lo descifra. */
export function decryptTask<T extends Row>(task: T): T {
  const out: Row = decryptModel('therapeuticTask', task);
  if (out.therapyGoal) out.therapyGoal = decryptTherapyGoal(out.therapyGoal);
  return out as T;
}

export function decryptAssessment<T extends Row>(assessment: T): T {
  const out: Row = decryptModel('clinicalAssessment', assessment);
  if ('answers' in out) out.answers = decryptJsonField<number[]>(out.answers, []);
  return out as T;
}

/** Ficha completa del paciente tal como la carga la exportación clínica (include de relaciones). */
export function decryptPatientRecord<T extends Row>(patient: T): T {
  const out: Row = decryptPatient(patient);
  const each = (key: string, fn: (row: Row) => Row) => { if (Array.isArray(out[key])) out[key] = out[key].map(fn); };
  if (out.clinicalHistory) out.clinicalHistory = decryptClinicalHistory(out.clinicalHistory);
  each('clinicalProcesses', decryptProcess);
  each('sessions', decryptSession);
  each('therapyGoals', decryptTherapyGoal);
  each('therapeuticTasks', decryptTask);
  each('clinicalAssessments', decryptAssessment);
  each('consentRecords', decryptConsent);
  each('clinicalReports', decryptReport);
  each('patientDocuments', decryptDocument);
  each('conversations', (c) => (Array.isArray(c.messages) ? { ...c, messages: c.messages.map(decryptMessage) } : c));
  return out as T;
}

/**
 * Red de seguridad para exportaciones: recorre el objeto y descifra cualquier string que aún
 * lleve prefijo de cifrado (un campo nuevo que alguien olvidó añadir al registro). Devuelve
 * también las rutas encontradas (sin valores) para poder registrarlas y corregir el registro.
 */
export function decryptDeep<T>(value: T, path = '$', found: string[] = []): { value: T; leakedPaths: string[] } {
  const walk = (v: any, p: string): any => {
    if (typeof v === 'string') {
      if (!isEncryptedValue(v)) return v;
      found.push(p);
      return decryptField(v);
    }
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${p}[${i}]`));
    const proto = v && typeof v === 'object' ? Object.getPrototypeOf(v) : undefined;
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item, `${p}.${k}`)]));
    }
    return v;
  };
  return { value: walk(value, path), leakedPaths: found };
}
