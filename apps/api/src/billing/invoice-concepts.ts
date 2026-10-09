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

/**
 * Campos de texto libre de facturación que solo ven OWNER/ADMIN. A cualquier otro rol (ASSISTANT)
 * le llegan a null, con un indicador `<campo>Hidden: true` si tenían contenido (condición de Argos).
 */
const INVOICE_FREE_TEXT = ['notes', 'voidReason'] as const;
const PAYMENT_FREE_TEXT = ['notes', 'reference', 'reversalReason'] as const;

function hideFreeText<T extends Record<string, any>>(row: T, fields: readonly string[]): T {
  const out: Record<string, any> = { ...row };
  for (const field of fields) {
    if (!(field in out)) continue;
    const hasText = typeof out[field] === 'string' && out[field].length > 0;
    out[field] = null;
    if (hasText) out[`${field}Hidden`] = true;
  }
  return out as T;
}

export function paymentForRole<T extends Record<string, any>>(payment: T, role: string): T {
  if (!payment || LEGACY_TEXT_ROLES.has(role)) return payment;
  return hideFreeText(payment, PAYMENT_FREE_TEXT);
}

/** Detalle de factura para el rol: líneas antiguas, notas, motivo de anulación y textos de pagos. */
export function invoiceForRole<T extends Record<string, any>>(invoice: T, role: string): T {
  if (!invoice || LEGACY_TEXT_ROLES.has(role)) return invoice;
  const out: Record<string, any> = hideFreeText(invoice, INVOICE_FREE_TEXT);
  if (Array.isArray(out.lines)) out.lines = linesForRole(out.lines, role);
  if (Array.isArray(out.payments)) out.payments = out.payments.map((p: Record<string, any>) => paymentForRole(p, role));
  return out as T;
}
