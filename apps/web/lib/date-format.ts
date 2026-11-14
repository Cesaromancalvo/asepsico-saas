/**
 * Fecha y hora en un único formato para toda la mensajería: «25 oct 2026, 22:03».
 *
 * Se arma con formatToParts para no depender de cómo cada versión de ICU puntúa el mes abreviado
 * («oct» / «oct.») ni del separador entre fecha y hora. Hora local del navegador, sin segundos.
 */
export function formatShortDateTime(value?: string | number | Date | null, empty = 'Sin actividad'): string {
  if (value == null || value === '') return empty;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return empty;
  const parts = new Intl.DateTimeFormat('es-ES', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const month = part('month').replace(/\.$/, '');
  return `${part('day')} ${month} ${part('year')}, ${part('hour')}:${part('minute')}`;
}
