import { isEmail } from 'class-validator';
import { PHONE_REGEX } from '../patients/dto/create-patient.dto';
import { isPlausibleBirthDate } from '../common/validators/plausible-birth-date.validator';
import { ImportField, normalizeHeader } from './column-mapping';
import { ImportFormat, RawRow } from './parsing/raw-table';

/**
 * Normalización y validación de filas (spec, apartado 6.2). Funciones puras: sin base de datos
 * y sin logs. Los mensajes de error nunca incluyen el valor de la celda.
 */

export type RowIssueCode =
  | 'REQUIRED'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'INVALID_TEXT'
  | 'INVALID_EMAIL'
  | 'INVALID_PHONE'
  | 'INVALID_PREFIX'
  | 'INVALID_DATE'
  | 'IMPLAUSIBLE_DATE'
  | 'INVALID_STATUS'
  | 'AMBIGUOUS_DATE'
  | 'MINOR';

export const ROW_ISSUE_MESSAGES: Record<RowIssueCode, string> = {
  REQUIRED: 'Falta este dato obligatorio',
  TOO_SHORT: 'Demasiado corto (mínimo 2 caracteres)',
  TOO_LONG: 'Demasiado largo',
  INVALID_TEXT: 'Contiene caracteres no permitidos',
  INVALID_EMAIL: 'Email no válido',
  INVALID_PHONE: 'Teléfono con formato no válido',
  INVALID_PREFIX: 'Prefijo telefónico no válido',
  INVALID_DATE: 'Fecha imposible o con formato no válido (usa dd/mm/aaaa o aaaa-mm-dd)',
  IMPLAUSIBLE_DATE: 'Fecha de nacimiento futura o de hace más de 120 años',
  INVALID_STATUS: 'Estado no válido (usa "activo" o "alta")',
  AMBIGUOUS_DATE: 'Fecha ambigua: se ha interpretado como día/mes; revísala',
  MINOR: 'Menor de edad: completa tutores y modo de acceso al portal después de importar',
};

export interface RowIssue {
  field: ImportField;
  code: RowIssueCode;
  message: string;
}

export interface ImportedValues {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  /** aaaa-mm-dd */
  birthDate: string | null;
  status: 'ACTIVE' | 'DISCHARGED';
}

export interface ValidatedRow {
  rowNumber: number;
  kind: 'VALID' | 'ERROR' | 'IGNORED';
  ignoredReason?: 'EXAMPLE' | 'EMPTY';
  values: Partial<ImportedValues>;
  errors: RowIssue[];
  warnings: RowIssue[];
}

export interface ColumnAssignment {
  index: number;
  field: ImportField;
}

export interface ValidationContext {
  format: ImportFormat;
  date1904: boolean;
  now?: Date;
}

const issue = (field: ImportField, code: RowIssueCode): RowIssue => ({ field, code, message: ROW_ISSUE_MESSAGES[code] });

// Texto que una hoja de cálculo podría interpretar como fórmula al reabrirse (inyección CSV), o
// con caracteres de control. Un nombre real no empieza así.
const FORMULA_START = /^[=+\-@\t\r]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function cellsFor(row: RawRow, assignments: ColumnAssignment[], field: ImportField): string[] {
  return assignments
    .filter((a) => a.field === field)
    .sort((a, b) => a.index - b.index)
    .map((a) => collapse(row.cells[a.index] ?? ''))
    .filter(Boolean);
}

function validateName(value: string, field: ImportField, errors: RowIssue[]): string {
  if (!value) errors.push(issue(field, 'REQUIRED'));
  else if (FORMULA_START.test(value) || CONTROL_CHARS.test(value)) errors.push(issue(field, 'INVALID_TEXT'));
  else if (value.length < 2) errors.push(issue(field, 'TOO_SHORT'));
  else if (value.length > 80) errors.push(issue(field, 'TOO_LONG'));
  return value;
}

// Algunas hojas de cálculo exportan con un apóstrofo delante para forzar texto ('+34, '600…).
const stripTextMarker = (value: string) => value.replace(/^'/, '');

export function normalizePrefix(raw: string): string | null {
  const compact = stripTextMarker(raw.trim()).replace(/[\s()-]/g, '');
  if (!compact) return null;
  const digits = compact.startsWith('+') ? compact.slice(1) : compact.startsWith('00') ? compact.slice(2) : compact;
  return /^\d{1,4}$/.test(digits) ? `+${digits}` : 'INVALID';
}

/** Clave de comparación de teléfonos: "+" y dígitos, con +34 si no trae prefijo internacional. */
export function phoneKey(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const international = trimmed.startsWith('+') ? trimmed : trimmed.startsWith('00') ? `+${trimmed.slice(2)}` : `+34${trimmed}`;
  const key = international.replace(/[^\d+]/g, '');
  return key.length > 4 ? key : null;
}

function normalizePhone(rawPhone: string, rawPrefix: string, errors: RowIssue[]): string | null {
  const phone = collapse(stripTextMarker(rawPhone.trim()).replace(/\./g, ' '));
  const prefix = normalizePrefix(rawPrefix);
  if (prefix === 'INVALID') {
    errors.push(issue('prefijo', 'INVALID_PREFIX'));
    return null;
  }
  if (!phone) return null;
  let full: string;
  if (phone.startsWith('+')) full = phone;
  else if (phone.startsWith('00')) full = `+${phone.slice(2)}`;
  else full = `${prefix ?? '+34'} ${phone}`;
  if (!PHONE_REGEX.test(full)) {
    errors.push(issue('telefono', 'INVALID_PHONE'));
    return null;
  }
  return full;
}

interface ParsedDate {
  iso: string | null;
  /** d/m/aaaa con día y mes ≤ 12 y distintos. */
  ambiguous: boolean;
  /** d/m/aaaa cuyo segundo número es > 12: indica un fichero con formato de EE. UU. */
  looksMonthFirst: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

function calendarIso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseDate(raw: string, ctx: ValidationContext): ParsedDate {
  const value = raw.trim();
  const none = { ambiguous: false, looksMonthFirst: false };
  // Fecha nativa de Excel: número de serie (solo en XLSX, que es donde Excel la guarda así).
  if (ctx.format === 'XLSX' && /^\d{1,6}(\.\d+)?$/.test(value)) {
    const serial = Math.floor(Number(value));
    if (serial < 1) return { iso: null, ...none };
    const base = ctx.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const date = new Date(base + serial * 86_400_000);
    return { iso: calendarIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()), ...none };
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+Z?)?$/.exec(value);
  if (iso) return { iso: calendarIso(Number(iso[1]), Number(iso[2]), Number(iso[3])), ...none };
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (dmy) {
    const first = Number(dmy[1]);
    const second = Number(dmy[2]);
    return {
      iso: calendarIso(Number(dmy[3]), second, first),
      ambiguous: first <= 12 && second <= 12 && first !== second,
      looksMonthFirst: first <= 12 && second > 12,
    };
  }
  return { iso: null, ...none };
}

function ageInYears(iso: string, now: Date): number {
  const [year, month, day] = iso.split('-').map(Number);
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)) age -= 1;
  return age;
}

const ACTIVE_WORDS = new Set(['', 'activo', 'activa', 'active', 'en curso']);
const DISCHARGED_WORDS = new Set(['alta', 'de alta', 'dado de alta', 'dada de alta', 'discharged']);

/**
 * Valida todas las filas de datos. `rows` ya excluye la cabecera. La detección de formato de
 * fecha de EE. UU. es por fichero: si alguna fecha solo tiene sentido como mes/día, se avisa en
 * todas las fechas ambiguas.
 */
export function validateRows(rows: RawRow[], assignments: ColumnAssignment[], ctx: ValidationContext): ValidatedRow[] {
  const now = ctx.now ?? new Date();
  const hasField = (field: ImportField) => assignments.some((a) => a.field === field);
  const dateColumn = assignments.find((a) => a.field === 'fecha_nacimiento');
  const fileLooksMonthFirst =
    dateColumn !== undefined && rows.some((row) => parseDate(row.cells[dateColumn.index] ?? '', ctx).looksMonthFirst);

  return rows.map((row) => {
    const errors: RowIssue[] = [];
    const warnings: RowIssue[] = [];
    const single = (field: ImportField) => cellsFor(row, assignments, field)[0] ?? '';
    const firstNameRaw = single('nombre');
    const lastNameRaw = cellsFor(row, assignments, 'apellidos').join(' ');

    const mappedCells = assignments.map((a) => collapse(row.cells[a.index] ?? ''));
    if (mappedCells.every((value) => value === '')) {
      return { rowNumber: row.rowNumber, kind: 'IGNORED', ignoredReason: 'EMPTY', values: {}, errors, warnings };
    }
    if (normalizeHeader(firstNameRaw) === 'ejemplo') {
      return { rowNumber: row.rowNumber, kind: 'IGNORED', ignoredReason: 'EXAMPLE', values: {}, errors, warnings };
    }

    const values: Partial<ImportedValues> = {
      firstName: validateName(firstNameRaw, 'nombre', errors),
      lastName: validateName(lastNameRaw, 'apellidos', errors),
      email: null,
      phone: null,
      birthDate: null,
      status: 'ACTIVE',
    };

    const email = single('email').toLowerCase();
    if (email) {
      if (email.length > 160) errors.push(issue('email', 'TOO_LONG'));
      else if (!isEmail(email)) errors.push(issue('email', 'INVALID_EMAIL'));
      else values.email = email;
    }

    if (hasField('telefono') || hasField('prefijo')) {
      values.phone = normalizePhone(single('telefono'), single('prefijo'), errors);
    }

    const rawDate = single('fecha_nacimiento');
    if (rawDate) {
      const parsed = parseDate(rawDate, ctx);
      if (!parsed.iso) errors.push(issue('fecha_nacimiento', 'INVALID_DATE'));
      else if (!isPlausibleBirthDate(parsed.iso)) errors.push(issue('fecha_nacimiento', 'IMPLAUSIBLE_DATE'));
      else {
        values.birthDate = parsed.iso;
        if (parsed.ambiguous && fileLooksMonthFirst) warnings.push(issue('fecha_nacimiento', 'AMBIGUOUS_DATE'));
        if (ageInYears(parsed.iso, now) < 18) warnings.push(issue('fecha_nacimiento', 'MINOR'));
      }
    }

    const status = normalizeHeader(single('estado'));
    if (DISCHARGED_WORDS.has(status)) values.status = 'DISCHARGED';
    else if (!ACTIVE_WORDS.has(status)) errors.push(issue('estado', 'INVALID_STATUS'));

    return { rowNumber: row.rowNumber, kind: errors.length ? 'ERROR' : 'VALID', values, errors, warnings };
  });
}

// ─── Duplicados (spec, apartado 6.3) ────────────────────────────────────────────────────────

export type DuplicateRule = 'EMAIL' | 'PHONE' | 'NAME_BIRTHDATE';

export interface OwnPatient {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  birthDate: Date | null;
  status: string;
}

export interface DuplicateMatch {
  source: 'EXISTING' | 'FILE';
  rule: DuplicateRule;
  /** Solo si source = EXISTING: un paciente del PROPIO importador. */
  patientId?: string;
  /** Solo si source = FILE: la fila anterior del mismo fichero. */
  row?: number;
  /** "Completar el existente" solo si el paciente existente admite modificaciones. */
  canComplete: boolean;
}

const nameKey = (firstName?: string | null, lastName?: string | null, birthDate?: string | null) =>
  firstName && lastName && birthDate ? `${normalizeHeader(`${firstName} ${lastName}`)}|${birthDate}` : null;

const isoDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

/**
 * Marca duplicados. `ownPatients` DEBE contener solo pacientes que el importador ya puede ver
 * (los suyos): nunca se compara contra toda la consulta, porque revelaría que otro profesional
 * atiende a esa persona.
 */
export function findDuplicates(rows: ValidatedRow[], ownPatients: OwnPatient[]): Map<number, DuplicateMatch> {
  const byEmail = new Map<string, OwnPatient>();
  const byPhone = new Map<string, OwnPatient>();
  const byName = new Map<string, OwnPatient>();
  for (const patient of ownPatients) {
    if (patient.email) byEmail.set(patient.email.trim().toLowerCase(), patient);
    const phone = phoneKey(patient.phone);
    if (phone) byPhone.set(phone, patient);
    const name = nameKey(patient.firstName, patient.lastName, isoDay(patient.birthDate));
    if (name) byName.set(name, patient);
  }

  const fileEmail = new Map<string, number>();
  const filePhone = new Map<string, number>();
  const fileName = new Map<string, number>();
  const result = new Map<number, DuplicateMatch>();

  for (const row of rows) {
    if (row.kind !== 'VALID') continue;
    const email = row.values.email ?? null;
    const phone = phoneKey(row.values.phone);
    const name = nameKey(row.values.firstName, row.values.lastName, row.values.birthDate);

    const existing: Array<[DuplicateRule, OwnPatient | undefined]> = [
      ['EMAIL', email ? byEmail.get(email) : undefined],
      ['PHONE', phone ? byPhone.get(phone) : undefined],
      ['NAME_BIRTHDATE', name ? byName.get(name) : undefined],
    ];
    const hit = existing.find(([, patient]) => patient);
    if (hit) {
      const patient = hit[1]!;
      result.set(row.rowNumber, {
        source: 'EXISTING',
        rule: hit[0],
        patientId: patient.id,
        canComplete: !['ARCHIVED', 'BLOCKED'].includes(patient.status),
      });
      continue;
    }

    const inFile: Array<[DuplicateRule, number | undefined]> = [
      ['EMAIL', email ? fileEmail.get(email) : undefined],
      ['PHONE', phone ? filePhone.get(phone) : undefined],
      ['NAME_BIRTHDATE', name ? fileName.get(name) : undefined],
    ];
    const fileHit = inFile.find(([, previous]) => previous !== undefined);
    if (fileHit) {
      result.set(row.rowNumber, { source: 'FILE', rule: fileHit[0], row: fileHit[1], canComplete: false });
      continue;
    }

    if (email) fileEmail.set(email, row.rowNumber);
    if (phone) filePhone.set(phone, row.rowNumber);
    if (name) fileName.set(name, row.rowNumber);
  }
  return result;
}

