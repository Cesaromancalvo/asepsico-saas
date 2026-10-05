/**
 * Campos importables: SOLO datos administrativos (decisión del Jefe, 30/09). No existe ningún
 * campo de destino clínico, así que ni el mapeo manual ni la API pueden asignar una columna a
 * motivo de consulta, notas, diagnóstico, etc.
 */
export const IMPORT_FIELDS = ['nombre', 'apellidos', 'email', 'telefono', 'prefijo', 'fecha_nacimiento', 'estado'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export const IGNORE_COLUMN = 'NO_IMPORTAR' as const;
export type ColumnTarget = ImportField | typeof IGNORE_COLUMN;

/** Campos que admiten varias columnas (se unen con un espacio): "Apellido 1" + "Apellido 2". */
export const MULTI_COLUMN_FIELDS: ReadonlySet<ImportField> = new Set(['apellidos']);

/** Minúsculas, sin tildes, sin puntuación y con espacios simples. */
export function normalizeHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

const KNOWN_HEADERS: Record<ImportField, string[]> = {
  nombre: ['nombre', 'nombres', 'first name', 'firstname', 'given name', 'nombre de pila'],
  apellidos: [
    'apellidos', 'apellido', 'apellido 1', 'apellido 2', 'apellido1', 'apellido2', 'primer apellido',
    'segundo apellido', 'last name', 'lastname', 'surname', 'family name',
  ],
  email: ['email', 'e mail', 'correo', 'correo electronico', 'mail', 'email address'],
  telefono: [
    'telefono', 'tel', 'telf', 'movil', 'telefono movil', 'telefono 1', 'telefono 2', 'celular', 'phone',
    'mobile', 'phone number', 'mobile phone',
  ],
  prefijo: ['prefijo', 'prefijo telefonico', 'prefijo pais', 'country code'],
  fecha_nacimiento: [
    'fecha nacimiento', 'fecha de nacimiento', 'f nacimiento', 'f nac', 'fecha nac', 'nacimiento', 'birth date',
    'birthdate', 'date of birth', 'dob',
  ],
  estado: ['estado', 'status', 'situacion'],
};

const HEADER_TO_FIELD = new Map<string, ImportField>(
  (Object.entries(KNOWN_HEADERS) as Array<[ImportField, string[]]>).flatMap(([field, headers]) =>
    headers.map((header) => [header, field] as [string, ImportField]),
  ),
);

/**
 * Palabras que marcan una columna como potencialmente clínica (spec, apartado 4). Se comparan
 * como palabra o comienzo de palabra de la cabecera normalizada: "Motivo de consulta",
 * "Diagnóstico principal", "Notas", "Historia clínica", "Observaciones"…
 */
const CLINICAL_KEYWORDS = [
  // 'obs' cubre "Obs.", "Observ." y "Observaciones"; 'seguim', "Seguimiento".
  'motivo', 'diagnostic', 'obs', 'seguim', 'nota', 'tratamiento', 'medicacion', 'medicamento', 'historia',
  'historial', 'comentario', 'antecedente', 'sintoma', 'patologia', 'evolucion', 'clinic', 'informe',
  'derivacion', 'terapia', 'trastorno', 'enfermedad', 'alergia', 'queja', 'demanda', 'objetivo', 'sesion',
  'anamnesis', 'riesgo', 'diagnosis', 'notes', 'reason', 'treatment', 'medication', 'history', 'comment',
];

export function isClinicalHeader(label: string): boolean {
  const words = normalizeHeader(label).split(' ').filter(Boolean);
  return words.some((word) => CLINICAL_KEYWORDS.some((keyword) => word.startsWith(keyword)));
}

export function suggestField(label: string): ImportField | null {
  if (isClinicalHeader(label)) return null;
  return HEADER_TO_FIELD.get(normalizeHeader(label)) ?? null;
}

export interface ColumnInfo {
  index: number;
  /** Texto de la cabecera (o "Columna N" si se indica que no hay cabecera). */
  label: string;
  clinical: boolean;
  suggestedField: ColumnTarget;
}

/**
 * Propuesta de mapeo para una fila de cabecera. Un campo de una sola columna solo se propone una
 * vez (si hay dos teléfonos, el segundo queda como "No importar"; el usuario puede cambiarlo).
 */
export function proposeMapping(headerCells: string[], columnCount: number, hasHeaderRow: boolean): ColumnInfo[] {
  const used = new Set<ImportField>();
  const columns: ColumnInfo[] = [];
  for (let index = 0; index < columnCount; index += 1) {
    const raw = hasHeaderRow ? (headerCells[index] ?? '').trim() : '';
    const label = raw || `Columna ${index + 1}`;
    const clinical = hasHeaderRow && isClinicalHeader(raw);
    let suggestedField: ColumnTarget = IGNORE_COLUMN;
    const suggestion = hasHeaderRow && !clinical ? suggestField(raw) : null;
    if (suggestion && (MULTI_COLUMN_FIELDS.has(suggestion) || !used.has(suggestion))) {
      suggestedField = suggestion;
      used.add(suggestion);
    }
    columns.push({ index, label, clinical, suggestedField });
  }
  return columns;
}
