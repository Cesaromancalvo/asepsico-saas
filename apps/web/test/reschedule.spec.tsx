import { describe, expect, it } from '@jest/globals';
import { SESSION_RESCHEDULE_ERROR_CODES } from '@asepsico/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import RescheduleSessionForm from '../components/RescheduleSessionForm';
import { ApiError } from '../lib/api';
import type { Viewer } from '../lib/clinical';
import {
  agendaWeekHref,
  buildRescheduleRange,
  canRescheduleSession,
  rescheduleDefaults,
  rescheduleErrorField,
  rescheduleErrorMessage,
} from '../lib/reschedule';
import {
  patientTasksToReviewHref,
  taskReviewPatientId,
  tasksToReviewHref,
  TASKS_TO_REVIEW_PAGE,
} from '../lib/routes';

// Noviembre de 2026 en Europe/Madrid = UTC+1. Las horas de los tests son las de la consulta.
const MAD = 'Europe/Madrid';
const local = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 10, d, h - 1, m)).toISOString();
const NOW = new Date(local(2, 9)); // lunes 2/11/2026, 9:00 en Madrid

const future = { id: 's1', therapistId: 'th1', startsAt: local(4, 10), endsAt: local(4, 10, 50), status: 'SCHEDULED' };

const viewer = (role: Viewer['role'], userId = 'u1'): Viewer => ({
  userId, role, isClinician: role === 'THERAPIST', firstName: null, lastName: null, workspaceName: null,
});

describe('canRescheduleSession', () => {
  it('recepción, titular y administración pueden mover cualquier cita futura', () => {
    expect(canRescheduleSession(future, viewer('ASSISTANT'), NOW)).toBe(true);
    expect(canRescheduleSession(future, viewer('OWNER'), NOW)).toBe(true);
    expect(canRescheduleSession(future, viewer('ADMIN'), NOW)).toBe(true);
  });

  it('un profesional solo mueve sus propias citas', () => {
    expect(canRescheduleSession(future, viewer('THERAPIST', 'th1'), NOW)).toBe(true);
    expect(canRescheduleSession(future, viewer('THERAPIST', 'th2'), NOW)).toBe(false);
    expect(canRescheduleSession({ ...future, therapistId: null, therapist: { id: 'th1' } }, viewer('THERAPIST', 'th1'), NOW)).toBe(true);
  });

  it('no se ofrece en citas pasadas, empezadas, cerradas o sin usuario', () => {
    expect(canRescheduleSession({ ...future, startsAt: local(2, 9) }, viewer('OWNER'), NOW)).toBe(false);
    expect(canRescheduleSession({ ...future, startsAt: local(1, 10) }, viewer('OWNER'), NOW)).toBe(false);
    expect(canRescheduleSession({ ...future, status: 'COMPLETED' }, viewer('OWNER'), NOW)).toBe(false);
    expect(canRescheduleSession({ ...future, status: 'CANCELLED' }, viewer('OWNER'), NOW)).toBe(false);
    expect(canRescheduleSession(future, null, NOW)).toBe(false);
  });
});

describe('buildRescheduleRange', () => {
  it('convierte fecha, hora y duración locales en instantes ISO con zona', () => {
    const result = buildRescheduleRange({ date: '2026-11-05', time: '12:30', duration: 60 }, future, NOW, MAD);
    expect(result).toEqual({ range: { startsAt: '2026-11-05T11:30:00.000Z', endsAt: '2026-11-05T12:30:00.000Z' } });
  });

  it('usa la zona horaria de la consulta, no la del navegador', () => {
    expect(buildRescheduleRange({ date: '2026-11-05', time: '12:30', duration: 50 }, future, NOW, 'America/Mexico_City'))
      .toEqual({ range: { startsAt: '2026-11-05T18:30:00.000Z', endsAt: '2026-11-05T19:20:00.000Z' } });
    expect(rescheduleDefaults(future, 'Atlantic/Canary')).toEqual({ date: '2026-11-04', time: '09:00', duration: 50 });
  });

  it('rechaza una hora que ya ha pasado', () => {
    expect(buildRescheduleRange({ date: '2026-11-02', time: '08:00', duration: 50 }, future, NOW, MAD))
      .toEqual({ error: 'Esa hora ya ha pasado. Elige una fecha y hora futuras.', field: 'time' });
  });

  it('rechaza campos vacíos, fechas imposibles y la misma hora', () => {
    expect(buildRescheduleRange({ date: '', time: '10:00', duration: 50 }, future, NOW, MAD)).toMatchObject({ field: 'date' });
    expect(buildRescheduleRange({ date: '2026-11-05', time: '', duration: 50 }, future, NOW, MAD)).toMatchObject({ field: 'time' });
    expect(buildRescheduleRange({ date: '2026-02-31', time: '10:00', duration: 50 }, future, NOW, MAD)).toMatchObject({ field: 'date' });
    expect(buildRescheduleRange({ date: '2026-11-05', time: '10:00', duration: 0 }, future, NOW, MAD)).toMatchObject({ field: 'duration' });
    expect(buildRescheduleRange({ date: '2026-11-04', time: '10:00', duration: 50 }, future, NOW, MAD)).toMatchObject({ field: 'time' });
  });

  it('los valores iniciales son los de la cita', () => {
    expect(rescheduleDefaults(future, MAD)).toEqual({ date: '2026-11-04', time: '10:00', duration: 50 });
  });
});

describe('errores de la API', () => {
  const apiError = (status: number, code?: string) => new ApiError('mensaje de la API', status, code);

  it('el solape y la hora pasada dan un mensaje claro y llevan el foco a la hora', () => {
    expect(rescheduleErrorMessage(apiError(400, 'SESSION_OVERLAP'))).toBe('Se solapa con otra cita de este profesional. Elige otra hora.');
    expect(rescheduleErrorField(apiError(400, 'SESSION_OVERLAP'))).toBe('time');
    expect(rescheduleErrorMessage(apiError(400, 'START_IN_PAST'))).toBe('Esa hora ya ha pasado. Elige una fecha y hora futuras.');
    expect(rescheduleErrorField(apiError(400, 'START_IN_PAST'))).toBe('time');
    expect(rescheduleErrorMessage(apiError(409, 'SLOT_NOT_AVAILABLE'))).toMatch(/^Hay una solicitud pendiente/);
  });

  it('todos los códigos del contrato tienen un mensaje propio', () => {
    for (const code of SESSION_RESCHEDULE_ERROR_CODES) {
      expect(rescheduleErrorMessage(apiError(400, code))).not.toBe('mensaje de la API');
    }
  });

  it('sin código conocido usa el estado o el mensaje de la API', () => {
    expect(rescheduleErrorMessage(apiError(403))).toBe('No tienes permiso para mover esta cita.');
    expect(rescheduleErrorMessage(apiError(400))).toBe('mensaje de la API');
    expect(rescheduleErrorMessage(new Error('red'))).toBe('No se pudo cambiar la cita. Revisa tu conexión y vuelve a intentarlo.');
  });
});

describe('RescheduleSessionForm', () => {
  it('pinta fecha, hora y duración con etiquetas y los valores de la cita', () => {
    const html = renderToStaticMarkup(
      <RescheduleSessionForm session={future} patientName="Ana Prueba" onCancel={() => undefined} onSaved={() => undefined} now={NOW} timeZone={MAD} />,
    );
    expect(html).toContain('Cambiar fecha u hora · Ana Prueba');
    expect(html).toContain('class="agenda-form"');
    expect(html).toMatch(/<span>Fecha<\/span><input[^>]*type="date"[^>]*value="2026-11-04"/);
    expect(html).toMatch(/<span>Hora<\/span><input[^>]*type="time"[^>]*value="10:00"/);
    expect(html).toMatch(/<option value="50" selected="">50 min<\/option>/);
    expect(html).toContain('Guardar cambio');
    expect(html).toContain('Si había solicitudes pendientes del paciente sobre esta cita, se cerrarán.');
  });

  it('una duración que no está en la lista se conserva como opción', () => {
    const html = renderToStaticMarkup(
      <RescheduleSessionForm session={{ ...future, endsAt: local(4, 11, 15) }} onCancel={() => undefined} onSaved={() => undefined} now={NOW} timeZone={MAD} />,
    );
    expect(html).toMatch(/<option value="75" selected="">75 min<\/option>/);
  });
});

describe('agenda en la semana de la cita', () => {
  it('lleva al lunes de la semana', () => {
    expect(agendaWeekHref(local(8, 10))).toBe('/agenda/?semana=2026-11-02'); // domingo 8 → lunes 2
    expect(agendaWeekHref(local(9, 10))).toBe('/agenda/?semana=2026-11-09');
  });
});

describe('«Tareas por revisar» de Mi jornada', () => {
  const id1 = 'cl1234567890abcdefghij';
  const id2 = 'cl0987654321abcdefghij';

  it('saca el paciente de los avisos de tareas y descarta lo que no es un id', () => {
    expect(taskReviewPatientId(`/patients/${id1}/tasks`)).toBe(id1);
    expect(taskReviewPatientId(`/patients/${id1}`)).toBe('');
    expect(taskReviewPatientId('/patients/..%2F/tasks')).toBe('');
  });

  it('con un paciente va a sus tareas con el filtro «Por revisar»; con varios, a la lista', () => {
    expect(patientTasksToReviewHref(id1)).toBe(`/patients/view/tasks/?id=${id1}&filtro=por-revisar`);
    expect(tasksToReviewHref([id1, id1])).toBe(`/patients/view/tasks/?id=${id1}&filtro=por-revisar`);
    expect(tasksToReviewHref([id1, id2])).toBe(TASKS_TO_REVIEW_PAGE);
    expect(tasksToReviewHref([])).toBe(TASKS_TO_REVIEW_PAGE);
  });
});
