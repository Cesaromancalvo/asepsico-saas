import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StaffEmailPreferencesResponse } from '@asepsico/contracts';

/* «Mi cuenta → Avisos por email» (N4). Datos ficticios; nada de pacientes. */

const apiMock = jest.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
jest.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
  }
  return { api: (path: string, init?: RequestInit) => apiMock(path, init), ApiError };
});

import EmailPreferencesPanel from '../components/EmailPreferencesPanel';
import { ApiError } from '../lib/api';
import {
  EMAIL_NOTIFICATIONS_PATH,
  fetchEmailPreferences,
  saveErrorMessage,
  updateEmailPreference,
  visibleKinds,
} from '../lib/email-preferences';

const THERAPIST: StaffEmailPreferencesResponse = {
  workspaceId: 'ws1',
  preferences: {
    appointmentRequests: { enabled: true, isDefault: true, available: true },
    patientCancellations: { enabled: false, isDefault: false, available: true },
    taskSubmitted: { enabled: false, isDefault: true, available: true },
  },
};

const ASSISTANT: StaffEmailPreferencesResponse = {
  workspaceId: 'ws1',
  preferences: {
    ...THERAPIST.preferences,
    taskSubmitted: { enabled: false, isDefault: true, available: false },
  },
};

function render(prefs: StaffEmailPreferencesResponse['preferences'], extra: Partial<Parameters<typeof EmailPreferencesPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <EmailPreferencesPanel workspaceName="Consulta Demo" preferences={prefs} rows={{}} status="" onToggle={() => undefined} {...extra} />,
  );
}

beforeEach(() => { apiMock.mockReset(); });

describe('API de avisos por email', () => {
  it('la ruta fija coincide con la que enlazan los emails', () => {
    expect(EMAIL_NOTIFICATIONS_PATH).toBe('/settings/email-notifications');
  });

  it('lee las preferencias del propio usuario', async () => {
    apiMock.mockResolvedValue(THERAPIST);
    await expect(fetchEmailPreferences()).resolves.toEqual(THERAPIST);
    expect(apiMock).toHaveBeenCalledWith('/notifications/email-preferences', undefined);
  });

  it('guarda solo la opción que cambia, con PATCH (el cliente añade CSRF)', async () => {
    apiMock.mockResolvedValue(THERAPIST);
    await updateEmailPreference('taskSubmitted', true);
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe('/notifications/email-preferences');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ taskSubmitted: true });
  });

  it('mensajes de error claros', () => {
    expect(saveErrorMessage('taskSubmitted', new ApiError('Forbidden', 403))).toBe('Tu rol no permite cambiar «Tareas entregadas».');
    expect(saveErrorMessage('appointmentRequests', new Error('x'))).toMatch(/No se ha podido guardar «Solicitudes de cita»/);
  });
});

describe('pantalla (N4-1)', () => {
  it('terapeuta: tres interruptores en orden, con su estado y si es el valor por defecto', () => {
    expect(visibleKinds(THERAPIST.preferences)).toEqual(['appointmentRequests', 'patientCancellations', 'taskSubmitted']);
    const html = render(THERAPIST.preferences);
    expect(html).toContain('Solicitudes de cita');
    expect(html).toContain('Cancelaciones de pacientes');
    expect(html).toContain('Tareas entregadas');
    expect(html.match(/role="switch"/g)).toHaveLength(3);
    expect(html).toContain('Valor por defecto');
    expect(html).toContain('Elegido por ti');
    expect(html).toMatch(/id="ep-appointmentRequests"[^>]*checked=""/);
    expect(html).not.toMatch(/id="ep-patientCancellations"[^>]*checked=""/);
  });

  it('recepción: no ve «Tareas entregadas»', () => {
    expect(visibleKinds(ASSISTANT.preferences)).toEqual(['appointmentRequests', 'patientCancellations']);
    const html = render(ASSISTANT.preferences);
    expect(html).not.toContain('Tareas entregadas');
    expect(html).not.toContain('ep-taskSubmitted');
    expect(html.match(/role="switch"/g)).toHaveLength(2);
  });

  it('explica que no hay datos de pacientes y la franja 21:00–07:00', () => {
    const html = render(THERAPIST.preferences);
    expect(html).toContain('no incluye nombres ni datos de pacientes');
    expect(html).toContain('entre las 21:00 y las 07:00');
    expect(html).toContain('Consulta Demo');
  });

  it('cada interruptor tiene etiqueta y descripción asociadas', () => {
    const html = render(THERAPIST.preferences);
    expect(html).toContain('for="ep-taskSubmitted"');
    expect(html).toContain('aria-describedby="ep-taskSubmitted-hint"');
    expect(html).toContain('id="ep-taskSubmitted-hint"');
  });

  it('guardando: interruptor deshabilitado; error: aviso asociado al interruptor', () => {
    const saving = render(THERAPIST.preferences, { rows: { appointmentRequests: { saving: true } } });
    expect(saving).toMatch(/id="ep-appointmentRequests"[^>]*disabled=""/);
    expect(saving).toContain('Guardando…');
    const failed = render(THERAPIST.preferences, { rows: { patientCancellations: { error: 'No se ha podido guardar.' } } });
    expect(failed).toContain('aria-describedby="ep-patientCancellations-hint ep-patientCancellations-error"');
    expect(failed).toContain('role="alert"');
  });

  it('sin opciones disponibles: estado vacío sin interruptores', () => {
    const none = Object.fromEntries(Object.entries(THERAPIST.preferences).map(([k, v]) => [k, { ...v, available: false }])) as StaffEmailPreferencesResponse['preferences'];
    const html = render(none);
    expect(html).not.toContain('role="switch"');
    expect(html).toContain('no hay avisos por email que configurar');
  });
});
