/**
 * Conversión entre hora local de una zona IANA y UTC sin dependencias externas (Intl de Node).
 * Respeta los cambios de horario de verano e invierno:
 *  - una hora local que no existe (salto de marzo, 02:00–03:00 en Europe/Madrid) devuelve null;
 *  - una hora local ambigua (repetida en octubre) se resuelve siempre al mismo instante, así que
 *    nunca hay huecos duplicados.
 */

export const DEFAULT_TIME_ZONE = 'Europe/Madrid';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Desfase de la zona respecto a UTC en ese instante, en milisegundos. */
function offsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Instante UTC de una hora local (año, mes 1-12, día, minutos desde las 00:00) en la zona.
 * Prueba los desfases de 12 h antes y después (cubren cualquier cambio de hora) y se queda con
 * los candidatos que de verdad caen en esa hora local:
 *  - ninguno → la hora no existe (salto de marzo) → null;
 *  - dos → hora repetida (octubre) → el primero, como `disambiguation: 'compatible'` de Temporal.
 */
export function localToUtc(year: number, month: number, day: number, minuteOfDay: number, timeZone: string): Date | null {
  const naive = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const expected = new Date(naive);
  const candidates = [...new Set([naive - offsetMs(naive - 12 * 3_600_000, timeZone), naive - offsetMs(naive + 12 * 3_600_000, timeZone)])]
    .filter((instant) => {
      const p = zonedParts(new Date(instant), timeZone);
      return p.year === expected.getUTCFullYear() && p.month === expected.getUTCMonth() + 1 && p.day === expected.getUTCDate()
        && p.hour * 60 + p.minute === expected.getUTCHours() * 60 + expected.getUTCMinutes();
    })
    .sort((a, b) => a - b);
  return candidates.length ? new Date(candidates[0]) : null;
}
