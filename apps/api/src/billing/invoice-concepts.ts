/**
 * Conceptos admitidos en una línea de factura: LISTA CERRADA (condición de Argos). Recepción
 * (ASSISTANT) tiene acceso a facturación y no debe ver contenido clínico; con texto libre, alguien
 * podría escribir el motivo de consulta en el concepto. Si hace falta uno nuevo, se añade aquí.
 * Copia para la web en packages/contracts (INVOICE_LINE_CONCEPTS); un test exige que coincidan.
 */
export const INVOICE_LINE_CONCEPTS = [
  'Sesión',
  'Sesión de psicología',
  'Sesión individual',
  'Sesión de pareja',
  'Sesión familiar',
  'Sesión de grupo',
  'Sesión online',
  'Primera consulta',
  'Sesión de evaluación',
  'Informe psicológico',
  'Bono de sesiones',
  'Otro concepto',
] as const;

export type InvoiceLineConcept = (typeof INVOICE_LINE_CONCEPTS)[number];

const CONCEPTS: ReadonlySet<string> = new Set(INVOICE_LINE_CONCEPTS);

export function isInvoiceLineConcept(value: unknown): value is InvoiceLineConcept {
  return typeof value === 'string' && CONCEPTS.has(value);
}

/** Roles que ven el texto de líneas antiguas fuera del catálogo (anteriores a la lista cerrada). */
const LEGACY_TEXT_ROLES = new Set(['OWNER', 'ADMIN']);

/**
 * Líneas para el DETALLE de una factura. Un concepto del catálogo se muestra a todos los roles de
 * facturación. Un texto libre antiguo (anterior a la lista cerrada) solo lo ven OWNER/ADMIN; a
 * cualquier otro rol (ASSISTANT) le llega como "Otro concepto" con legacyDescriptionHidden.
 */
export function linesForRole<T extends { description: string }>(lines: T[] | undefined, role: string): (T & { legacyDescriptionHidden?: true })[] {
  if (!Array.isArray(lines)) return [];
  if (LEGACY_TEXT_ROLES.has(role)) return lines;
  return lines.map((line) => (isInvoiceLineConcept(line.description) ? line : { ...line, description: 'Otro concepto', legacyDescriptionHidden: true as const }));
}

/** Concepto resumido para el LISTADO (sin líneas): el de la primera línea si es del catálogo. */
export function summaryConcept(lines: { description: string }[] | undefined): InvoiceLineConcept | null {
  const first = Array.isArray(lines) ? lines[0]?.description : undefined;
  if (first === undefined) return null;
  return isInvoiceLineConcept(first) ? first : 'Otro concepto';
}
