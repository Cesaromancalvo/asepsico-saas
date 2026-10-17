import { localToUtc, zonedParts } from './time-zone.util';

export type WeeklyWindow = { weekday: number; startMinute: number; endMinute: number };
export type Interval = { startsAt: Date; endsAt: Date };

export type SlotSettings = {
  sessionMinutes: number;
  breakMinutes: number;
  minNoticeHours: number;
  maxHorizonDays: number;
};

export type SlotQuery = SlotSettings & {
  timeZone: string;
  windows: WeeklyWindow[];
  now: Date;
  /** Citas no canceladas, solicitudes pendientes y bloqueos: no se distinguen entre sí. */
  busy: Interval[];
  from?: Date;
  to?: Date;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Primer y último inicio de hueco admitidos por las antelaciones mínima y máxima. */
export function bookingRange(settings: SlotSettings, now: Date): { earliest: Date; latest: Date } {
  return {
    earliest: new Date(now.getTime() + settings.minNoticeHours * HOUR),
    latest: new Date(now.getTime() + settings.maxHorizonDays * DAY),
  };
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < b.endsAt && a.endsAt > b.startsAt;
}

/**
 * Huecos ofrecidos = rejilla de las franjas − ocupado − fuera de antelaciones.
 * La rejilla empieza al inicio de cada franja y avanza de (duración + descanso) en
 * (duración + descanso); un hueco que terminaría después del fin de la franja no se ofrece.
 * Los cálculos se hacen en hora local de la zona del espacio.
 */
export function computeSlots(query: SlotQuery): Interval[] {
  const { earliest, latest } = bookingRange(query, query.now);
  const from = query.from && query.from > earliest ? query.from : earliest;
  const to = query.to && query.to < latest ? query.to : latest;
  if (from > to || query.sessionMinutes <= 0) return [];

  const step = query.sessionMinutes + query.breakMinutes;
  const today = zonedParts(query.now, query.timeZone);
  const seen = new Set<number>();
  const slots: Interval[] = [];

  // Un día de margen a cada lado: la fecha local puede ir por delante o por detrás de UTC.
  for (let offset = -1; offset <= query.maxHorizonDays + 1; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset, 12));
    const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    const windows = query.windows.filter((w) => w.weekday === weekday);
    for (const window of windows) {
      for (let minute = window.startMinute; minute + query.sessionMinutes <= window.endMinute; minute += step) {
        const startsAt = localToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), minute, query.timeZone);
        if (!startsAt) continue; // hora local inexistente (cambio de hora de marzo)
        if (startsAt < from || startsAt > to || seen.has(startsAt.getTime())) continue;
        const slot = { startsAt, endsAt: new Date(startsAt.getTime() + query.sessionMinutes * MINUTE) };
        if (query.busy.some((busy) => overlaps(slot, busy))) continue;
        seen.add(startsAt.getTime());
        slots.push(slot);
      }
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * ¿Es `startsAt` un inicio de la rejilla dentro de las antelaciones? No mira lo ocupado: eso se
 * comprueba después, dentro de la transacción con el profesional bloqueado.
 */
export function findGridSlot(query: Omit<SlotQuery, 'busy' | 'from' | 'to'>, startsAt: Date): Interval | null {
  if (Number.isNaN(startsAt.getTime())) return null;
  const [slot] = computeSlots({ ...query, busy: [], from: startsAt, to: startsAt });
  return slot && slot.startsAt.getTime() === startsAt.getTime() ? slot : null;
}

/** Valida franjas: día 1-7, múltiplos de 15 min, inicio < fin y sin solapes en el mismo día. */
export function validateWindows(windows: WeeklyWindow[]): string | null {
  const sorted = [...windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  for (let i = 0; i < sorted.length; i += 1) {
    const w = sorted[i];
    if (!Number.isInteger(w.weekday) || w.weekday < 1 || w.weekday > 7) return 'Día de la semana no válido';
    if (w.startMinute % 15 !== 0 || w.endMinute % 15 !== 0) return 'Las franjas van en intervalos de 15 minutos';
    if (w.startMinute < 0 || w.endMinute > 1440 || w.startMinute >= w.endMinute) return 'Franja horaria no válida';
    const prev = sorted[i - 1];
    if (prev && prev.weekday === w.weekday && prev.endMinute > w.startMinute) return 'Hay franjas que se solapan en el mismo día';
  }
  return null;
}
