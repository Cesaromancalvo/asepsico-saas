/*
 * Reserva de citas desde el portal: textos, fechas y reglas puras de la web.
 *
 * Sin dependencias de React ni de la red, para poder probarlo con Jest. Los tipos vienen de
 * @asepsico/contracts. Tres reglas de producto que se cuidan aquí:
 *  - Los textos del paciente van en tuteo, cálidos y sin tecnicismos.
 *  - Los motivos de bloqueo y de rechazo son listas cerradas: no hay texto libre.
 *  - Las horas del profesional se editan y se muestran en la zona horaria de la consulta (no en la
 *    del navegador), también al cambiar el horario de verano.
 */
import type {
  AppointmentRequestStatus,
  AppointmentRequestType,
  AvailabilityWindowContract,
  BlockReason,
  PortalSlotContract,
  RejectionReason,
} from '@asepsico/contracts';

/* ------------------------------------------------------------------------------------------ */
/* Textos                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export const WEEKDAYS = [
  { n: 1, label: 'Lunes' }, { n: 2, label: 'Martes' }, { n: 3, label: 'Miércoles' }, { n: 4, label: 'Jueves' },
  { n: 5, label: 'Viernes' }, { n: 6, label: 'Sábado' }, { n: 7, label: 'Domingo' },
] as const;

export const BLOCK_REASON_LABEL: Record<BlockReason, string> = {
  VACATION: 'Vacaciones',
  TRAINING: 'Formación',
  PERSONAL: 'Asuntos personales',
  OTHER: 'Otro motivo',
};

export const REJECTION_REASON_LABEL: Record<RejectionReason, string> = {
  SLOT_UNAVAILABLE: 'Ese horario ya no está disponible',
  DISCUSS_IN_SESSION: 'Lo hablamos en sesión',
  CONTACT_PRACTICE: 'Contacta con la consulta',
};

/** Lo que ve el profesional en la bandeja. */
export const STAFF_TYPE_LABEL: Record<AppointmentRequestType, string> = {
  NEW: 'Cita nueva',
  RESCHEDULE: 'Cambio de cita',
  CANCEL: 'Cancelación de cita',
};

export const STAFF_STATUS_LABEL: Record<AppointmentRequestStatus, string> = {
  PENDING: 'Pendiente',
  APPROVED: 'Aprobada',
  REJECTED: 'Rechazada',
  EXPIRED: 'Caducada',
  WITHDRAWN: 'Retirada por el paciente',
};

/** Lo que ve el paciente. */
export const PORTAL_TYPE_LABEL: Record<AppointmentRequestType, string> = {
  NEW: 'Cita nueva',
  RESCHEDULE: 'Cambio de cita',
  CANCEL: 'Cancelación de cita',
};

export const PORTAL_STATUS_LABEL: Record<AppointmentRequestStatus, string> = {
  PENDING: 'Pendiente de confirmar',
  APPROVED: 'Aprobada',
  REJECTED: 'Rechazada',
  EXPIRED: 'Caducada',
  WITHDRAWN: 'Retirada',
};

/** Clase de color del sistema visual (chip-*) para cada estado. */
export const STATUS_TONE: Record<AppointmentRequestStatus, string> = {
  PENDING: 'chip-amber',
  APPROVED: 'chip-green',
  REJECTED: 'chip-red',
  EXPIRED: 'chip-neutral',
  WITHDRAWN: 'chip-neutral',
};

/** Frase de cierre de una solicitud para el paciente. Sin tecnicismos y sin culpar a nadie. */
export function portalStatusNote(status: AppointmentRequestStatus, type: AppointmentRequestType, reason: RejectionReason | null): string | null {
  switch (status) {
    case 'PENDING':
      return type === 'CANCEL'
        ? 'Tu cita sigue en pie hasta que la consulta responda.'
        : type === 'RESCHEDULE'
          ? 'Tu cita actual sigue en pie hasta que la consulta confirme el cambio.'
          : 'La consulta te confirmará la cita.';
    case 'APPROVED':
      return type === 'CANCEL' ? 'La cita se ha cancelado.' : type === 'RESCHEDULE' ? 'Tu cita ya está en la nueva hora.' : 'Tu cita está confirmada.';
    case 'REJECTED':
      return reason ? `${REJECTION_REASON_LABEL[reason]}.` : 'La consulta no ha podido aceptarla.';
    case 'EXPIRED':
      return 'Nadie pudo responder a tiempo. Puedes pedir otra hora cuando quieras.';
    case 'WITHDRAWN':
      return 'Retiraste esta solicitud.';
    default:
      return null;
  }
}

/** Aviso que siempre acompaña a la reserva (la API envía el mismo texto; esta es la copia de reserva). */
export const EMERGENCY_FALLBACK = 'Esto no es un canal de urgencias. Si lo necesitas, llama al 024 o al 112.';

/** Mensajes para los códigos estables de la API; si no hay, se usa el texto que envía el servidor. */
export function bookingErrorMessage(status: number | undefined, code: string | undefined, apiMessage: string): string {
  if (code === 'SLOT_NOT_AVAILABLE') return 'Esa hora se acaba de ocupar. Hemos actualizado las horas libres: elige otra.';
  if (code === 'TOO_MANY_PENDING_REQUESTS') return 'Ya tienes una solicitud pendiente. Espera a que la consulta responda o retírala para pedir otra.';
  if (code === 'REQUEST_ALREADY_PENDING') return 'Ya hay una solicitud en curso para esta cita.';
  if (code === 'WITHIN_CANCELLATION_WINDOW') return 'Falta poco para esta cita, así que no se puede cambiar desde aquí. Llama a la consulta.';
  if (code === 'BOOKING_UNAVAILABLE') return 'Ahora mismo no se puede pedir cita desde aquí. Contacta con la consulta.';
  if (status === 429) return 'Has enviado muchas solicitudes seguidas. Espera un poco y vuelve a intentarlo.';
  return apiMessage || 'No hemos podido completar la acción. Inténtalo de nuevo.';
}

/* ------------------------------------------------------------------------------------------ */
/* Horas y franjas                                                                             */
/* ------------------------------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, '0');

/** 540 -> "09:00". 1440 -> "24:00" (fin de día). */
export function minuteToTime(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** "09:30" -> 570. null si no es una hora válida (o es "24:00" para el inicio). */
export function timeToMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

export function windowsOfDay(windows: AvailabilityWindowContract[], weekday: number): AvailabilityWindowContract[] {
  return windows.filter((w) => w.weekday === weekday).sort((a, b) => a.startMinute - b.startMinute);
}

/** Reglas de la API repetidas en la pantalla para avisar antes de guardar. null = todo bien. */
export function validateWindows(windows: AvailabilityWindowContract[]): string | null {
  const sorted = [...windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  for (let i = 0; i < sorted.length; i += 1) {
    const w = sorted[i];
    const day = WEEKDAYS.find((d) => d.n === w.weekday)?.label ?? 'Un día';
    if (!Number.isInteger(w.startMinute) || !Number.isInteger(w.endMinute)) return `${day}: revisa las horas de la franja.`;
    if (w.startMinute % 15 !== 0 || w.endMinute % 15 !== 0) return `${day}: las franjas van en intervalos de 15 minutos.`;
    if (w.startMinute < 0 || w.endMinute > 1440 || w.startMinute >= w.endMinute) return `${day}: la hora de fin debe ser posterior a la de inicio.`;
    const prev = sorted[i - 1];
    if (prev && prev.weekday === w.weekday && prev.endMinute > w.startMinute) return `${day}: hay franjas que se solapan.`;
  }
  return null;
}

/** Copia las franjas de un día a otros días (sustituye lo que hubiera en ellos). */
export function copyDayWindows(windows: AvailabilityWindowContract[], fromDay: number, toDays: number[]): AvailabilityWindowContract[] {
  const source = windowsOfDay(windows, fromDay);
  const targets = new Set(toDays.filter((d) => d !== fromDay));
  const kept = windows.filter((w) => !targets.has(w.weekday));
  const copies = [...targets].flatMap((weekday) => source.map((w) => ({ ...w, weekday })));
  return [...kept, ...copies].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
}

/** Nueva franja tras la última del día (o 09:00-14:00 si el día está vacío). */
export function addWindowToDay(windows: AvailabilityWindowContract[], weekday: number): AvailabilityWindowContract[] {
  const day = windowsOfDay(windows, weekday);
  const last = day[day.length - 1];
  const start = last ? Math.min(last.endMinute + 60, 1320) : 540;
  const end = Math.min(start + (last ? 120 : 300), 1440);
  return [...windows, { weekday, startMinute: start, endMinute: end }];
}

/* ------------------------------------------------------------------------------------------ */
/* Zonas horarias                                                                              */
/* ------------------------------------------------------------------------------------------ */

export const COMMON_TIME_ZONES = [
  'Europe/Madrid', 'Atlantic/Canary', 'Europe/Lisbon', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome',
  'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires',
] as const;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('es-ES', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatter(timeZone: string | undefined) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** Año, mes, día, hora y minuto locales de un instante en una zona (la del navegador si no se indica). */
function zonedFields(ms: number, timeZone: string | undefined) {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** Día local "AAAA-MM-DD" y minutos desde medianoche de un instante. */
export function zonedParts(iso: string, timeZone?: string): { dateKey: string; minute: number } {
  const f = zonedFields(new Date(iso).getTime(), timeZone);
  return { dateKey: `${f.year}-${pad(f.month)}-${pad(f.day)}`, minute: f.hour * 60 + f.minute };
}

function offsetMs(ms: number, timeZone: string): number {
  const f = zonedFields(ms, timeZone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - ms;
}

/** Instante UTC (ISO) en que en `timeZone` son las `minute` del día `dateKey`. Respeta el cambio de hora. */
export function zonedTimeToUtc(dateKey: string, minute: number, timeZone: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, minute, 0);
  let guess = naive - offsetMs(naive, timeZone);
  guess = naive - offsetMs(guess, timeZone);
  return new Date(guess).toISOString();
}

export function addDaysToKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Bloqueos                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export type BlockForm = { fromDate: string; toDate: string; allDay: boolean; fromTime: string; toTime: string };

/**
 * Del formulario de bloqueo al rango que espera la API. "Todo el día": desde las 00:00 del primer
 * día hasta las 00:00 del día siguiente al último (los dos días cuentan).
 */
export function blockFormToRange(form: BlockForm, timeZone: string): { startsAt: string; endsAt: string } | { error: string } {
  const dateOk = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!dateOk(form.fromDate) || !dateOk(form.toDate)) return { error: 'Elige las fechas del bloqueo.' };
  if (form.toDate < form.fromDate) return { error: 'La fecha final no puede ser anterior a la inicial.' };
  let startMinute = 0;
  let endDate = addDaysToKey(form.toDate, 1);
  let endMinute = 0;
  if (!form.allDay) {
    const from = timeToMinute(form.fromTime);
    const to = timeToMinute(form.toTime);
    if (from === null || to === null) return { error: 'Indica la hora de inicio y la de fin.' };
    startMinute = from;
    endDate = form.toDate;
    endMinute = to;
  }
  const startsAt = zonedTimeToUtc(form.fromDate, startMinute, timeZone);
  const endsAt = zonedTimeToUtc(endDate, endMinute, timeZone);
  if (new Date(endsAt) <= new Date(startsAt)) return { error: 'El final del bloqueo debe ser posterior al inicio.' };
  return { startsAt, endsAt };
}

function dayLabel(dateKey: string, withYear = false): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** "Del 1 ago al 15 ago 2026" o "12 oct, de 10:00 a 12:00", en la zona de la consulta. */
export function formatBlockRange(startsAt: string, endsAt: string, timeZone: string): string {
  const start = zonedParts(startsAt, timeZone);
  const end = zonedParts(endsAt, timeZone);
  const wholeDays = start.minute === 0 && end.minute === 0;
  if (wholeDays) {
    const lastDay = addDaysToKey(end.dateKey, -1);
    const year = lastDay.slice(0, 4);
    return lastDay === start.dateKey ? `${dayLabel(start.dateKey, true)}, todo el día` : `Del ${dayLabel(start.dateKey)} al ${dayLabel(lastDay)} ${year}`;
  }
  if (start.dateKey === end.dateKey) return `${dayLabel(start.dateKey, true)}, de ${minuteToTime(start.minute)} a ${minuteToTime(end.minute)}`;
  return `${dayLabel(start.dateKey)} ${minuteToTime(start.minute)} – ${dayLabel(end.dateKey, true)} ${minuteToTime(end.minute)}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Huecos y calendario del portal                                                              */
/* ------------------------------------------------------------------------------------------ */

export function timeLabel(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('es-ES', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** "jueves 5 de noviembre" de un instante en una zona. Se compone a mano: el orden y las comas de Intl varían según la versión de ICU. */
function dayText(date: Date, timeZone: string | undefined): string {
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('es-ES', { timeZone, ...options }).format(date);
  return `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} de ${part({ month: 'long' })}`;
}

/** "jueves 5 de noviembre" a partir de "2026-11-05". */
export function longDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return dayText(new Date(Date.UTC(y, m - 1, d, 12)), 'UTC');
}

/** "jueves 5 de noviembre, 10:00" de un instante. */
export function longDateTimeLabel(iso: string, timeZone?: string): string {
  return `${dayText(new Date(iso), timeZone)}, ${timeLabel(iso, timeZone)}`;
}

export function monthLabel(year: number, month0: number): string {
  return new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(year, month0, 1, 12)));
}

/** Huecos agrupados por día local de la consulta ("AAAA-MM-DD"), cada día ordenado por hora. */
export function groupSlotsByDay(slots: PortalSlotContract[], timeZone?: string): Record<string, PortalSlotContract[]> {
  const grouped: Record<string, PortalSlotContract[]> = {};
  for (const slot of [...slots].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const key = zonedParts(slot.startsAt, timeZone).dateKey;
    (grouped[key] ??= []).push(slot);
  }
  return grouped;
}

/** Semanas (lunes primero) de un mes; null en los días de relleno. */
export function monthGrid(year: number, month0: number): (string | null)[][] {
  const first = new Date(Date.UTC(year, month0, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const total = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= total; day += 1) cells.push(`${year}-${pad(month0 + 1)}-${pad(day)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Meses (año, mes 0-11) en los que hay algún hueco, de menor a mayor. */
export function monthsWithSlots(days: string[]): { year: number; month0: number }[] {
  const seen = new Set<string>();
  const out: { year: number; month0: number }[] = [];
  for (const key of [...days].sort()) {
    const id = key.slice(0, 7);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ year: Number(key.slice(0, 4)), month0: Number(key.slice(5, 7)) - 1 });
  }
  return out;
}

/** Nombre completo para mostrar al paciente: "Ana García". */
export function personName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

/** Contador de la navegación: "3 solicitudes pendientes". */
export function pendingLabel(count: number): string {
  return count === 1 ? '1 solicitud pendiente' : `${count} solicitudes pendientes`;
}

/** Evento de ventana con el que la bandeja avisa a la barra lateral de que cambió el contador. */
export const PENDING_REQUESTS_EVENT = 'asepsico:pending-requests';

/**
 * ¿Puede esta persona activar o desactivar la reserva desde el portal de ese profesional?
 * El propio profesional, la persona titular y administración sí; recepción nunca (la API
 * responde 403 y lo audita: la pantalla ni siquiera ofrece el interruptor).
 */
export function canToggleBooking(role: string | null | undefined, isSelf: boolean): boolean {
  if (role === 'OWNER' || role === 'ADMIN') return true;
  return role === 'THERAPIST' && isSelf;
}
