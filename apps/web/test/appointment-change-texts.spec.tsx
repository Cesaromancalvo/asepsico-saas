import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';

/*
 * «Cambios de agenda» en Mi jornada (recorrido de demo 14/11, punto 8). El texto lo compone la API
 * al leer el aviso (renderAppointmentChange); la tarjeta lo pinta tal cual. Aquí se comprueba el
 * texto final que ve el profesional. Datos ficticios.
 */
import { renderAppointmentChange } from '../../api/src/notifications/appointment-change-notice.util';

const FROM = { startsAt: '2026-11-17T11:00:00.000Z', endsAt: '2026-11-17T11:50:00.000Z' }; // martes 17/11, 12:00 Madrid
const base = { therapistId: 't-a', sessionId: null, requestId: 'r1', from: FROM, to: null } as const;

describe('Mi jornada → Cambios de agenda', () => {
  it('«ha retirado su solicitud de cita del martes 17 de noviembre, 12:00» (sin «de pedir» ni coma tras el día)', () => {
    const body = renderAppointmentChange({ ...base, change: 'PATIENT_WITHDREW_REQUEST', requestType: 'NEW' }, 'Lucía Inventada', false, 'Europe/Madrid');
    expect(body).toBe('Lucía Inventada ha retirado su solicitud de cita del martes 17 de noviembre, 12:00.');
    // La tarjeta pinta el texto tal cual, sin añadir nada.
    expect(renderToStaticMarkup(<p>{body}</p>)).toBe('<p>Lucía Inventada ha retirado su solicitud de cita del martes 17 de noviembre, 12:00.</p>');
  });

  it('rechazada y cancelada, igual de directas', () => {
    expect(renderAppointmentChange({ ...base, change: 'REQUEST_REJECTED', requestType: 'CANCEL', sessionId: 's1' }, 'Lucía Inventada', false, 'Europe/Madrid'))
      .toBe('Se ha rechazado la cancelación que pidió Lucía Inventada de la cita del martes 17 de noviembre, 12:00.');
    expect(renderAppointmentChange({ ...base, change: 'CANCELLED_BY_STAFF', requestType: null, requestId: null, sessionId: 's1' }, 'Lucía Inventada', true, 'Europe/Madrid'))
      .toBe('Se ha cancelado tu cita con Lucía Inventada del martes 17 de noviembre, 12:00.');
  });
});
