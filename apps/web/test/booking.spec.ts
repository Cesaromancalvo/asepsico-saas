import { describe, expect, it } from '@jest/globals';
import { APPOINTMENT_REQUEST_STATUSES, BLOCK_REASONS, REJECTION_REASONS } from '@asepsico/contracts';
import {
  addDaysToKey, addWindowToDay, BLOCK_REASON_LABEL, blockFormToRange, bookingErrorMessage, canToggleBooking, copyDayWindows,
  formatBlockRange, groupSlotsByDay, longDayLabel, minuteToTime, monthGrid, monthsWithSlots, pendingLabel, PORTAL_STATUS_LABEL,
  portalStatusNote, REJECTION_REASON_LABEL, STAFF_STATUS_LABEL, timeToMinute, validateWindows, zonedTimeToUtc,
} from '../lib/booking';

const MADRID = 'Europe/Madrid';

describe('Disponibilidad: franjas', () => {
  it('convierte minutos en hora y al revés', () => {
    expect(minuteToTime(540)).toBe('09:00');
    expect(minuteToTime(1440)).toBe('24:00');
    expect(timeToMinute('09:30')).toBe(570);
    expect(timeToMinute('24:00')).toBe(1440);
    expect(timeToMinute('25:00')).toBeNull();
    expect(timeToMinute('9')).toBeNull();
  });

  it('valida como la API: 15 minutos, inicio antes que fin y sin solapes en el mismo día', () => {
    expect(validateWindows([{ weekday: 2, startMinute: 540, endMinute: 840 }, { weekday: 2, startMinute: 960, endMinute: 1200 }])).toBeNull();
    expect(validateWindows([{ weekday: 2, startMinute: 545, endMinute: 840 }])).toMatch(/15 minutos/);
    expect(validateWindows([{ weekday: 2, startMinute: 840, endMinute: 540 }])).toMatch(/posterior/);
    expect(validateWindows([{ weekday: 2, startMinute: 540, endMinute: 840 }, { weekday: 2, startMinute: 780, endMinute: 900 }])).toMatch(/solapan/);
    // El mismo tramo en días distintos no es un solape.
    expect(validateWindows([{ weekday: 1, startMinute: 540, endMinute: 840 }, { weekday: 2, startMinute: 540, endMinute: 840 }])).toBeNull();
  });

  it('copiar un día sustituye las franjas de los destinos y deja el resto', () => {
    const base = [
      { weekday: 1, startMinute: 540, endMinute: 840 },
      { weekday: 2, startMinute: 600, endMinute: 660 },
      { weekday: 6, startMinute: 600, endMinute: 720 },
    ];
    const copied = copyDayWindows(base, 1, [2, 3]);
    expect(copied.filter((w) => w.weekday === 2)).toEqual([{ weekday: 2, startMinute: 540, endMinute: 840 }]);
    expect(copied.filter((w) => w.weekday === 3)).toHaveLength(1);
    expect(copied.filter((w) => w.weekday === 6)).toHaveLength(1);
    expect(copyDayWindows(base, 1, [1])).toEqual(base.sort((a, b) => a.weekday - b.weekday));
  });

  it('añadir franja propone 09:00-14:00 en un día vacío y una tarde detrás de la última', () => {
    expect(addWindowToDay([], 3)).toEqual([{ weekday: 3, startMinute: 540, endMinute: 840 }]);
    const next = addWindowToDay([{ weekday: 3, startMinute: 540, endMinute: 840 }], 3);
    expect(next[1]).toEqual({ weekday: 3, startMinute: 900, endMinute: 1020 });
    expect(validateWindows(next)).toBeNull();
  });
});

describe('Disponibilidad: zona horaria de la consulta y cambio de hora', () => {
  it('9:00 en Madrid son las 07:00 UTC en verano y las 08:00 UTC en invierno', () => {
    expect(zonedTimeToUtc('2026-08-01', 540, MADRID)).toBe('2026-08-01T07:00:00.000Z');
    expect(zonedTimeToUtc('2026-12-01', 540, MADRID)).toBe('2026-12-01T08:00:00.000Z');
  });

  it('un bloqueo de todo el día del cambio de hora de octubre dura 25 horas', () => {
    const range = blockFormToRange({ fromDate: '2026-10-25', toDate: '2026-10-25', allDay: true, fromTime: '', toTime: '' }, MADRID);
    expect(range).toEqual({ startsAt: '2026-10-24T22:00:00.000Z', endsAt: '2026-10-25T23:00:00.000Z' });
  });

  it('vacaciones del 1 al 15 de agosto: incluye los dos días', () => {
    const range = blockFormToRange({ fromDate: '2026-08-01', toDate: '2026-08-15', allDay: true, fromTime: '', toTime: '' }, MADRID);
    expect(range).toEqual({ startsAt: '2026-07-31T22:00:00.000Z', endsAt: '2026-08-15T22:00:00.000Z' });
    expect(formatBlockRange('2026-07-31T22:00:00.000Z', '2026-08-15T22:00:00.000Z', MADRID)).toMatch(/^Del 1 ago\.? al 15 ago\.? 2026$/);
  });

  it('un tramo horario usa la hora de la consulta y rechaza rangos al revés', () => {
    const range = blockFormToRange({ fromDate: '2026-11-05', toDate: '2026-11-05', allDay: false, fromTime: '10:00', toTime: '12:00' }, MADRID);
    expect(range).toEqual({ startsAt: '2026-11-05T09:00:00.000Z', endsAt: '2026-11-05T11:00:00.000Z' });
    expect(formatBlockRange('2026-11-05T09:00:00.000Z', '2026-11-05T11:00:00.000Z', MADRID)).toMatch(/de 10:00 a 12:00$/);
    expect(blockFormToRange({ fromDate: '2026-11-05', toDate: '2026-11-05', allDay: false, fromTime: '12:00', toTime: '10:00' }, MADRID)).toHaveProperty('error');
    expect(blockFormToRange({ fromDate: '2026-11-06', toDate: '2026-11-05', allDay: true, fromTime: '', toTime: '' }, MADRID)).toHaveProperty('error');
    expect(blockFormToRange({ fromDate: '', toDate: '', allDay: true, fromTime: '', toTime: '' }, MADRID)).toHaveProperty('error');
  });

  it('suma días a una fecha sin saltarse el cambio de mes', () => {
    expect(addDaysToKey('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysToKey('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('Portal: calendario de huecos', () => {
  it('agrupa por el día local de la consulta, no por el del navegador ni por UTC', () => {
    const grouped = groupSlotsByDay([
      { startsAt: '2026-11-05T09:00:00.000Z', endsAt: '2026-11-05T09:50:00.000Z' },
      { startsAt: '2026-11-05T23:30:00.000Z', endsAt: '2026-11-06T00:20:00.000Z' },
      { startsAt: '2026-11-05T10:00:00.000Z', endsAt: '2026-11-05T10:50:00.000Z' },
    ], MADRID);
    expect(Object.keys(grouped)).toEqual(['2026-11-05', '2026-11-06']);
    expect(grouped['2026-11-05'].map((s) => s.startsAt)).toEqual(['2026-11-05T09:00:00.000Z', '2026-11-05T10:00:00.000Z']);
  });

  it('el mes empieza en lunes: noviembre de 2026 arranca en domingo', () => {
    const weeks = monthGrid(2026, 10);
    expect(weeks).toHaveLength(6);
    expect(weeks[0]).toEqual([null, null, null, null, null, null, '2026-11-01']);
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it('lista los meses con huecos de menor a mayor, sin repetir', () => {
    expect(monthsWithSlots(['2026-12-02', '2026-11-30', '2026-11-05'])).toEqual([{ year: 2026, month0: 10 }, { year: 2026, month0: 11 }]);
    expect(monthsWithSlots([])).toEqual([]);
  });

  it('etiqueta el día en español', () => {
    expect(longDayLabel('2026-11-05')).toBe('jueves 5 de noviembre');
  });
});

describe('Textos: listas cerradas y tono', () => {
  it('todos los motivos y estados de la API tienen texto (no hay motivos libres)', () => {
    for (const reason of BLOCK_REASONS) expect(BLOCK_REASON_LABEL[reason]).toBeTruthy();
    for (const reason of REJECTION_REASONS) expect(REJECTION_REASON_LABEL[reason]).toBeTruthy();
    for (const status of APPOINTMENT_REQUEST_STATUSES) {
      expect(STAFF_STATUS_LABEL[status]).toBeTruthy();
      expect(PORTAL_STATUS_LABEL[status]).toBeTruthy();
    }
  });

  it('el paciente ve el estado en sus palabras: pendiente, aprobada, rechazada con motivo, caducada', () => {
    expect(PORTAL_STATUS_LABEL.PENDING).toBe('Pendiente de confirmar');
    expect(portalStatusNote('REJECTED', 'NEW', 'DISCUSS_IN_SESSION')).toBe('Lo hablamos en sesión.');
    expect(portalStatusNote('EXPIRED', 'NEW', null)).toMatch(/pedir otra hora/);
    expect(portalStatusNote('PENDING', 'RESCHEDULE', null)).toMatch(/sigue en pie/);
    expect(portalStatusNote('PENDING', 'CANCEL', null)).toMatch(/sigue en pie/);
  });

  it('los errores se explican sin tecnicismos', () => {
    expect(bookingErrorMessage(409, 'SLOT_NOT_AVAILABLE', 'x')).toMatch(/elige otra/);
    expect(bookingErrorMessage(409, 'TOO_MANY_PENDING_REQUESTS', 'x')).toMatch(/Ya tienes una solicitud pendiente/);
    expect(bookingErrorMessage(429, undefined, 'ThrottlerException')).toMatch(/Espera/);
    expect(bookingErrorMessage(500, undefined, '')).toMatch(/Inténtalo de nuevo/);
    expect(bookingErrorMessage(400, undefined, 'Texto de la API')).toBe('Texto de la API');
  });

  it('el contador de la navegación solo dice cuántas, sin nombres ni fechas', () => {
    expect(pendingLabel(1)).toBe('1 solicitud pendiente');
    expect(pendingLabel(3)).toBe('3 solicitudes pendientes');
  });
});

describe('Permisos de la pantalla (la API manda; la web no insinúa lo que no corresponde)', () => {
  it('solo el propio profesional, titular y administración activan la reserva; recepción nunca', () => {
    expect(canToggleBooking('THERAPIST', true)).toBe(true);
    expect(canToggleBooking('THERAPIST', false)).toBe(false);
    expect(canToggleBooking('OWNER', false)).toBe(true);
    expect(canToggleBooking('ADMIN', false)).toBe(true);
    expect(canToggleBooking('ASSISTANT', false)).toBe(false);
    expect(canToggleBooking('ASSISTANT', true)).toBe(false);
    expect(canToggleBooking(null, true)).toBe(false);
  });
});
