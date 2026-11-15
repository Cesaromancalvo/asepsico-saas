import { AppointmentChangeMeta, renderAppointmentChange } from '../src/notifications/appointment-change-notice.util';

/*
 * Textos del bloque «Cambios de agenda» de Mi jornada (recorrido de demo 14/11, punto 8): frases
 * directas, fecha «martes 17 de noviembre, 12:00» (sin coma tras el día de la semana).
 * Datos ficticios. La seguridad de qué se guarda y quién lo lee está en appointment-change-notices.
 */
const TZ = 'Europe/Madrid';
// Martes 17/11/2026 12:00 y jueves 19/11/2026 10:00 en Madrid (CET, UTC+1).
const FROM = { startsAt: '2026-11-17T11:00:00.000Z', endsAt: '2026-11-17T11:50:00.000Z' };
const TO = { startsAt: '2026-11-19T09:00:00.000Z', endsAt: '2026-11-19T09:50:00.000Z' };
const NAME = 'Lucía Inventada';

const meta = (over: Partial<AppointmentChangeMeta>): AppointmentChangeMeta => ({
  change: 'RESCHEDULED_BY_STAFF', therapistId: 't-a', sessionId: 'ses-1', requestId: null, requestType: null, from: FROM, to: TO, ...over,
});
const text = (over: Partial<AppointmentChangeMeta>, own = false) => renderAppointmentChange(meta(over), NAME, own, TZ);

describe('Textos de «Cambios de agenda»', () => {
  it('retirar una solicitud de cita nueva: «ha retirado su solicitud de cita del martes 17 de noviembre, 12:00»', () => {
    expect(text({ change: 'PATIENT_WITHDREW_REQUEST', requestType: 'NEW', sessionId: null, requestId: 'r1', to: null }))
      .toBe('Lucía Inventada ha retirado su solicitud de cita del martes 17 de noviembre, 12:00.');
  });

  it('retirar un cambio o una cancelación pedidos', () => {
    expect(text({ change: 'PATIENT_WITHDREW_REQUEST', requestType: 'RESCHEDULE', requestId: 'r1' }))
      .toBe('Lucía Inventada ha retirado su solicitud de cambio de la cita del martes 17 de noviembre, 12:00.');
    expect(text({ change: 'PATIENT_WITHDREW_REQUEST', requestType: 'CANCEL', requestId: 'r1', to: null }))
      .toBe('Lucía Inventada ha retirado su solicitud de cancelación de la cita del martes 17 de noviembre, 12:00.');
  });

  it('rechazadas: mismo patrón que las aprobadas', () => {
    expect(text({ change: 'REQUEST_REJECTED', requestType: 'NEW', sessionId: null, requestId: 'r1', from: null }))
      .toBe('Se ha rechazado la cita que pidió Lucía Inventada para el jueves 19 de noviembre, 10:00.');
    expect(text({ change: 'REQUEST_REJECTED', requestType: 'CANCEL', requestId: 'r1', to: null }))
      .toBe('Se ha rechazado la cancelación que pidió Lucía Inventada de la cita del martes 17 de noviembre, 12:00.');
    expect(text({ change: 'REQUEST_REJECTED', requestType: 'RESCHEDULE', requestId: 'r1' }))
      .toBe('Se ha rechazado el cambio que pidió Lucía Inventada de la cita del martes 17 de noviembre, 12:00.');
  });

  it('cancelada, movida y peticiones del paciente', () => {
    expect(text({ change: 'CANCELLED_BY_STAFF', to: null }, true))
      .toBe('Se ha cancelado tu cita con Lucía Inventada del martes 17 de noviembre, 12:00.');
    expect(text({ change: 'RESCHEDULED_BY_STAFF' }, true))
      .toBe('Se ha movido tu cita con Lucía Inventada del martes 17 de noviembre, 12:00 al jueves 19 de noviembre, 10:00.');
    expect(text({ change: 'PATIENT_REQUESTED_RESCHEDULE', requestType: 'RESCHEDULE', requestId: 'r1' }))
      .toBe('Lucía Inventada pide cambiar la cita del martes 17 de noviembre, 12:00 al jueves 19 de noviembre, 10:00.');
    expect(text({ change: 'PATIENT_REQUESTED_CANCEL', requestType: 'CANCEL', requestId: 'r1', to: null }))
      .toBe('Lucía Inventada pide cancelar la cita del martes 17 de noviembre, 12:00.');
  });

  it('ningún texto repite «solicitud de pedir» ni pone coma tras el día de la semana', () => {
    const all = (['NEW', 'RESCHEDULE', 'CANCEL'] as const).flatMap((requestType) =>
      (['PATIENT_WITHDREW_REQUEST', 'REQUEST_REJECTED', 'REQUEST_APPROVED', 'CANCELLED_BY_STAFF', 'RESCHEDULED_BY_STAFF'] as const)
        .map((change) => text({ change, requestType })));
    for (const line of all) {
      expect(line).not.toMatch(/solicitud de pedir|de pedir la cita/);
      expect(line).not.toMatch(/(lunes|martes|miércoles|jueves|viernes|sábado|domingo),/);
    }
  });
});
