/**
 * Teléfono de la lista de espera (política lista-espera-v5). FUENTE ÚNICA de la regla: la usan el
 * alta pública y el CLI waitlist:set-phone. La landing replica la regla para dar el error al
 * momento, pero la API no confía en ella. Ninguna función de aquí registra ni devuelve en un error
 * el valor recibido.
 *
 * Regla (spec de Vega, P1 = se aceptan internacionales con «+», P2 = regla afinada):
 *  1. Se quitan espacios, puntos, guiones y paréntesis. Lo que queda solo puede ser dígitos con un
 *     «+» opcional al principio.
 *  2. España: «+34», «0034» o «34» (este último solo con 11 dígitos en total) seguido de 9 dígitos,
 *     o 9 dígitos sin prefijo. Los 9 dígitos tienen que ser un móvil (6xx, 71x–74x) o un fijo
 *     geográfico (8[1-8]x, 9[1-8]x). Se excluyen 70x (número personal) y 80x/90x (tarificación
 *     especial y servicios), que nunca son el teléfono de una persona.
 *  3. Internacional: «+» o «00» seguido de un prefijo distinto de 34 (sin 0 inicial), con 8 a 15
 *     dígitos en total (límite de E.164). No se valida el plan de numeración de cada país.
 *  4. Se guarda en E.164: «+34» y los 9 dígitos, o «+» y los dígitos del internacional.
 */

/** Longitud máxima de lo que se acepta del formulario (antes de limpiar). */
export const WAITLIST_PHONE_MAX_INPUT_LENGTH = 25;

/** Móvil o fijo geográfico español (9 dígitos, sin prefijo). */
const SPANISH_NATIONAL = /^(6\d{8}|7[1-4]\d{7}|[89][1-8]\d{7})$/;
/** Separadores que la gente escribe y se ignoran. \s incluye el espacio duro (U+00A0). */
const SEPARATORS = /[\s.()-]/g;

export function normalizeWaitlistPhone(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > WAITLIST_PHONE_MAX_INPUT_LENGTH) return null;
  const compact = input.replace(SEPARATORS, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  let international: string | null = null;
  if (compact.startsWith('+')) international = compact.slice(1);
  else if (compact.startsWith('00')) international = compact.slice(2);

  if (international === null) {
    // Sin prefijo internacional: 9 dígitos nacionales, o 34 + 9 dígitos (ningún número español empieza por 3).
    const national = compact.length === 11 && compact.startsWith('34') ? compact.slice(2) : compact;
    return SPANISH_NATIONAL.test(national) ? `+34${national}` : null;
  }
  if (international.startsWith('34')) {
    const national = international.slice(2);
    return SPANISH_NATIONAL.test(national) ? `+34${national}` : null;
  }
  if (!/^[1-9]\d{7,14}$/.test(international)) return null;
  return `+${international}`;
}
