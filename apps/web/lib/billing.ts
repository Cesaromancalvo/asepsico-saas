/*
 * Control de cobros en la web. Recepción (ASSISTANT) lo usa pero no debe ver texto libre que
 * pueda ser clínico: la API le envía esos campos a null con un indicador `<campo>Hidden: true`
 * (BillingFreeTextFlagsContract) y las líneas antiguas fuera del catálogo como "Otro concepto"
 * con `legacyDescriptionHidden`. Aquí solo se traduce eso a lo que se enseña.
 */

// Textos revisados por Clio (afirmaciones v7: "control de cobros", no "facturación").
export const HIDDEN_FOR_ROLE = 'No visible con tu rol';
export const CLINICAL_TEXT_HINT = 'Escribe solo datos administrativos, nada clínico.';
export const OTHER_CONCEPT = 'Otro concepto';

/**
 * Estado del cobro tal y como se enseña (el valor de la API no cambia). "Pendiente" en vez de
 * "Emitida" para no sugerir una factura legal (afirmaciones v7: control de cobros). [CLIO]
 */
export const CHARGE_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Borrador', ISSUED: 'Pendiente', PARTIALLY_PAID: 'Pago parcial', PAID: 'Pagado', VOID: 'Anulado', OVERDUE: 'Vencido',
};
export const chargeStatusLabel = (status: string) => CHARGE_STATUS_LABELS[status] ?? status;

/** Concepto de una línea del detalle: "Otro concepto" si la API ocultó un texto libre antiguo. */
export function lineLabel(line: { description: string; legacyDescriptionHidden?: boolean }): string {
  return line.legacyDescriptionHidden ? OTHER_CONCEPT : line.description;
}

/**
 * Texto libre del detalle: el valor; HIDDEN_FOR_ROLE si la API lo ocultó (nunca un hueco vacío
 * que haga pensar que no hay nada); o null si de verdad está vacío (y entonces no se pinta la fila).
 */
export function freeText(value: string | null | undefined, hidden: boolean | undefined): { text: string; hidden: boolean } | null {
  if (hidden) return { text: HIDDEN_FOR_ROLE, hidden: true };
  return value?.trim() ? { text: value, hidden: false } : null;
}
