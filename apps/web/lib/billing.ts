/*
 * Facturación en la web. Recepción (ASSISTANT) usa facturación pero no debe ver texto libre que
 * pueda ser clínico: la API le envía esos campos a null con un indicador `<campo>Hidden: true`
 * (BillingFreeTextFlagsContract) y las líneas antiguas fuera del catálogo como "Otro concepto"
 * con `legacyDescriptionHidden`. Aquí solo se traduce eso a lo que se enseña.
 */

// [CLIO] Textos pendientes de revisión.
export const HIDDEN_FOR_ROLE = 'Oculto para tu rol';
export const CLINICAL_TEXT_HINT = 'No escribas información clínica.';
export const OTHER_CONCEPT = 'Otro concepto';

/** Concepto de una línea del detalle: "Otro concepto" si la API ocultó un texto libre antiguo. */
export function lineLabel(line: { description: string; legacyDescriptionHidden?: boolean }): string {
  return line.legacyDescriptionHidden ? OTHER_CONCEPT : line.description;
}

/**
 * Texto libre del detalle: el valor; "Oculto para tu rol" si la API lo ocultó (nunca un hueco vacío
 * que haga pensar que no hay nada); o null si de verdad está vacío (y entonces no se pinta la fila).
 */
export function freeText(value: string | null | undefined, hidden: boolean | undefined): { text: string; hidden: boolean } | null {
  if (hidden) return { text: HIDDEN_FOR_ROLE, hidden: true };
  return value?.trim() ? { text: value, hidden: false } : null;
}
