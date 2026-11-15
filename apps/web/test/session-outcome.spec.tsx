import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Viewer } from '../lib/clinical';

/* «¿Se hizo esta sesión?» (recorrido de demo 14/11, punto 6). Datos ficticios. */

const apiMock = jest.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
jest.mock('../lib/api', () => ({ api: (path: string, init?: RequestInit) => apiMock(path, init) }));

import { SessionOutcomeView } from '../components/SessionOutcomePrompt';
import {
  canCloseSession,
  closeSessionOutcome,
  isAwaitingOutcome,
  isOwnSession,
  OUTCOME_OPTIONS,
  outcomeEnabledForRecord,
  outcomeContext,
  outcomeNotice,
  shouldAskOutcome,
  timelineSessionId,
} from '../lib/session-outcome';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const PAST = { id: 's1', status: 'SCHEDULED', startsAt: '2026-11-17T09:00:00.000Z', therapistId: 't-a' };
const viewer = (role: Viewer['role'], userId = 'u-1'): Viewer => ({ userId, role, isClinician: role !== 'ASSISTANT', firstName: null, lastName: null, workspaceName: null });

beforeEach(() => { apiMock.mockReset(); });

describe('cuándo se pregunta', () => {
  it('solo si sigue programada y ya ha empezado', () => {
    expect(isAwaitingOutcome(PAST, NOW)).toBe(true);
    expect(isAwaitingOutcome({ ...PAST, startsAt: '2026-11-17T12:30:00.000Z' }, NOW)).toBe(false);
    expect(isAwaitingOutcome({ ...PAST, startsAt: NOW.toISOString() }, NOW)).toBe(false);
    for (const status of ['COMPLETED', 'NO_SHOW', 'CANCELLED']) expect(isAwaitingOutcome({ ...PAST, status }, NOW)).toBe(false);
    expect(isAwaitingOutcome({ ...PAST, startsAt: 'no-es-fecha' }, NOW)).toBe(false);
  });

  it('roles como la API: OWNER, ADMIN y recepción cualquier cita; THERAPIST solo las suyas', () => {
    expect(canCloseSession(PAST, viewer('OWNER'))).toBe(true);
    expect(canCloseSession(PAST, viewer('ADMIN'))).toBe(true);
    expect(canCloseSession(PAST, viewer('ASSISTANT'))).toBe(true);
    expect(canCloseSession(PAST, viewer('THERAPIST', 't-a'))).toBe(true);
    expect(canCloseSession({ therapist: { id: 't-a' } }, viewer('THERAPIST', 't-a'))).toBe(true);
    expect(canCloseSession(PAST, viewer('THERAPIST', 't-b'))).toBe(false);
    expect(canCloseSession({}, viewer('THERAPIST', 't-a'))).toBe(false);
    expect(canCloseSession(PAST, null)).toBe(false);
    expect(canCloseSession(PAST, viewer(null))).toBe(false);
  });

  it('shouldAskOutcome combina las dos cosas', () => {
    expect(shouldAskOutcome(PAST, viewer('THERAPIST', 't-a'), NOW)).toBe(true);
    expect(shouldAskOutcome(PAST, viewer('THERAPIST', 't-b'), NOW)).toBe(false);
    expect(shouldAskOutcome({ ...PAST, status: 'COMPLETED' }, viewer('OWNER'), NOW)).toBe(false);
  });

  it('reconoce las sesiones de la línea temporal («session-<id>») y nada más', () => {
    expect(timelineSessionId({ id: 'session-abc', type: 'SESSION' })).toBe('abc');
    expect(timelineSessionId({ id: 'task-abc', type: 'TASK' })).toBeNull();
    expect(timelineSessionId({ id: 'session-', type: 'SESSION' })).toBeNull();
  });
});

describe('cerrar la cita', () => {
  it('usa el endpoint existente PATCH /sessions/:id/close y solo envía el estado (sin nota)', async () => {
    apiMock.mockResolvedValue({});
    await closeSessionOutcome('s1', 'COMPLETED');
    expect(apiMock).toHaveBeenCalledWith('/sessions/s1/close', { method: 'PATCH', body: JSON.stringify({ status: 'COMPLETED' }) });
    const body = JSON.parse(String(apiMock.mock.calls[0][1]?.body));
    expect(Object.keys(body)).toEqual(['status']);
  });

  it('las tres opciones, en orden y con los estados de la API', () => {
    expect(OUTCOME_OPTIONS.map((o) => [o.label, o.status])).toEqual([['Realizada', 'COMPLETED'], ['No vino', 'NO_SHOW'], ['Cancelada', 'CANCELLED']]);
    // «Realizada» va de un clic; las otras dos piden confirmación (no se pueden deshacer).
    expect(OUTCOME_OPTIONS.map((o) => o.confirm !== null)).toEqual([false, true, true]);
  });

  it('el aviso recuerda la nota solo a quien puede escribirla (la sesión es suya)', () => {
    expect(outcomeNotice('COMPLETED', true)).toContain('añadir la nota');
    expect(outcomeNotice('COMPLETED', false)).toBe('Sesión marcada como realizada.');
    expect(outcomeNotice('NO_SHOW', true)).toBe('Sesión marcada como «No vino».');
    expect(outcomeNotice('CANCELLED', false)).toBe('Sesión marcada como cancelada.');
    expect(isOwnSession(PAST, viewer('THERAPIST', 't-a'))).toBe(true);
    expect(isOwnSession(PAST, viewer('ASSISTANT', 'r-1'))).toBe(false);
  });

  it('contexto accesible sin coma tras el día de la semana', () => {
    const text = outcomeContext('Lucía Inventada', '2026-11-17T11:00:00.000Z');
    expect(text).toMatch(/^Lucía Inventada, martes 17 de noviembre, \d{2}:00$/);
  });
});

describe('SessionOutcomeView', () => {
  const noop = () => undefined;
  const render = (extra: Partial<Parameters<typeof SessionOutcomeView>[0]> = {}) => renderToStaticMarkup(
    <SessionOutcomeView context="Lucía Inventada, martes 17 de noviembre, 10:00" busy={false} confirming={null} error="" onPick={noop} onConfirm={noop} onBack={noop} {...extra} />,
  );
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

  it('pregunta «¿Se hizo esta sesión?» con Realizada · No vino · Cancelada', () => {
    const html = render();
    expect(html).toContain('¿Se hizo esta sesión?');
    expect(buttons(html)).toEqual(['Realizada', 'No vino', 'Cancelada']);
    expect(html.match(/<button type="button"/g)).toHaveLength(3);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="¿Se hizo esta sesión? Lucía Inventada, martes 17 de noviembre, 10:00"');
    // Sin campos de nota: «Realizada» no la pide.
    expect(html).not.toMatch(/<textarea|<input/);
  });

  it('«No vino» pide confirmar y deja volver', () => {
    const html = render({ confirming: 'NO_SHOW' });
    expect(html).toContain('¿Marcar que el paciente no vino? No se puede deshacer.');
    expect(buttons(html)).toEqual(['Sí, «No vino»', 'Volver']);
  });

  it('mientras guarda deshabilita los botones', () => {
    const html = render({ busy: true, confirming: 'COMPLETED' });
    expect(buttons(html)).toEqual(['Guardando…', 'No vino', 'Cancelada']);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it('el error se anuncia', () => {
    expect(render({ error: 'La sesión ya está cerrada' })).toContain('role="alert">La sesión ya está cerrada');
  });
});

describe('dónde aparece', () => {
  const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');
  it.each(['app/agenda/page.tsx', 'app/page.tsx', 'components/AdminDayView.tsx', 'app/patients/view/page.tsx', 'app/patients/view/plan/page.tsx'])(
    '%s monta la pregunta solo con shouldAskOutcome o con la lista ya filtrada',
    (path) => {
      const code = source(path);
      expect(code).toContain('<SessionOutcomePrompt');
      expect(code).toMatch(/shouldAskOutcome\(session, viewer\)|usePendingOutcomeSessions\(/);
    },
  );

  it('el portal del paciente no la usa', () => {
    expect(source('app/portal/page.tsx')).not.toContain('SessionOutcome');
  });
});

describe('acceso excepcional: ni la ficha ni el plan preguntan (revisión de Argos)', () => {
  const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

  it('solo se pregunta si trata al paciente y la parte clínica no se ha denegado', () => {
    // OWNER/ADMIN con acceso excepcional: lee la ficha pero no la trata.
    expect(outcomeEnabledForRecord({ treating: false })).toBe(false);
    expect(outcomeEnabledForRecord({ treating: true }, true)).toBe(false);
    expect(outcomeEnabledForRecord({ treating: true })).toBe(true);
  });

  it('el plan y la ficha condicionan la carga al criterio «trata al paciente»', () => {
    const plan = source('app/patients/view/plan/page.tsx');
    expect(plan).toContain('usePatientClinicalAccess(');
    expect(plan).toMatch(/usePendingOutcomeSessions\(patientId,viewer,Boolean\(patient\)&&outcomeEnabledForRecord\(clinicalAccess\)\)/);
    expect(plan).not.toMatch(/usePendingOutcomeSessions\(patientId,viewer,Boolean\(patient\)\)/);
    const record = source('app/patients/view/page.tsx');
    expect(record).toMatch(/usePendingOutcomeSessions\(patientId,viewer,outcomeEnabledForRecord\(access,clinicalDenied\)\)/);
  });

  it('la vista de solo lectura del acceso excepcional no monta la pregunta', () => {
    expect(source('components/ExceptionalRecordView.tsx')).not.toContain('SessionOutcome');
  });
});
