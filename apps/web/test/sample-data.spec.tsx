import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SampleDataStatusContract, SamplePortalAccessContract, StaffRole } from '@asepsico/contracts';

/* E1 · Espacio de prueba cargado. Datos ficticios; ningún paciente real. */

const apiMock = jest.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
jest.mock('../lib/api', () => {
  class ApiError extends Error {
    body: Record<string, unknown> = {};
    constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
  }
  return { api: (path: string, init?: RequestInit) => apiMock(path, init), ApiError, SESSION_EXPIRED: 'SESSION_EXPIRED' };
});
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('a', { href, ...rest }, children);
  },
}));

import SampleDataSection, { ClearSampleDataDialog, SamplePortalCredentials } from '../components/SampleDataSection';
import { SampleDataNoticeView } from '../components/SampleDataNotice';
import { ApiError } from '../lib/api';
import type { Viewer } from '../lib/clinical';
import {
  canManageSampleData,
  clearErrorMessage,
  clearResultMessage,
  clearSampleData,
  isSampleNoticeDismissed,
  loadSampleDataStatus,
  portalAccessErrorMessage,
  PORTAL_LOGIN_PATH,
  requestSamplePortalAccess,
  SAMPLE_NOTICE_CLINICIAN,
  SAMPLE_NOTICE_NO_REAL_DATA,
  SAMPLE_NOTICE_TITLE,
  sampleStatusSummary,
  setSampleNoticeDismissed,
  shouldShowSampleNotice,
} from '../lib/sample-data';

const LOADED: SampleDataStatusContract = {
  loaded: true,
  loadedAt: '2026-11-12T09:00:00.000Z',
  clearedAt: null,
  samplePatients: 5,
  portalPatient: { patientId: 'c000000000000000000001', firstName: 'Lucía', lastName: 'Ejemplo' },
};

const ACCESS: SamplePortalAccessContract = {
  patientId: 'c000000000000000000001',
  firstName: 'Lucía',
  lastName: 'Ejemplo',
  email: 'paciente.prueba@example.test',
  temporaryPassword: 'Tmp-Ficticia-1234',
  mustChangePassword: true,
};

const viewer = (role: StaffRole | null): Viewer => ({ userId: 'u1', role, isClinician: true, firstName: 'Ana', lastName: 'Prueba', workspaceName: 'Consulta Demo' });

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: jest.fn((k: string) => data.get(k) ?? null),
    setItem: jest.fn((k: string, v: string) => { data.set(k, v); }),
    removeItem: jest.fn((k: string) => { data.delete(k); }),
  };
}

beforeEach(() => { apiMock.mockReset(); });

describe('solo la persona titular (OWNER)', () => {
  it.each<StaffRole>(['ADMIN', 'THERAPIST', 'ASSISTANT'])('%s: ni gestiona ni ve el aviso, y no se pregunta a la API', async (role) => {
    expect(canManageSampleData(role)).toBe(false);
    expect(shouldShowSampleNotice(role, LOADED)).toBe(false);
    await expect(loadSampleDataStatus(role)).resolves.toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('sin rol (sesión desconocida) tampoco', async () => {
    await expect(loadSampleDataStatus(null)).resolves.toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('OWNER: lee GET /sample-data', async () => {
    apiMock.mockResolvedValue(LOADED);
    await expect(loadSampleDataStatus('OWNER')).resolves.toEqual(LOADED);
    expect(apiMock).toHaveBeenCalledWith('/sample-data', undefined);
  });

  it('un 403 (rol cambiado) o un 404 (fuera del piloto demo) se tratan como «nada que enseñar»', async () => {
    apiMock.mockRejectedValue(new ApiError('Forbidden', 403));
    await expect(loadSampleDataStatus('OWNER')).resolves.toBeNull();
    apiMock.mockRejectedValue(new ApiError('Not Found', 404));
    await expect(loadSampleDataStatus('OWNER')).resolves.toBeNull();
  });

  it('otros errores se lanzan (la sección muestra «Intentar de nuevo»)', async () => {
    apiMock.mockRejectedValue(new ApiError('Error', 500));
    await expect(loadSampleDataStatus('OWNER')).rejects.toBeInstanceOf(ApiError);
  });

  it('la sección no se pinta para otros roles ni sin usuario', () => {
    for (const role of ['ADMIN', 'THERAPIST', 'ASSISTANT', null] as const) {
      expect(renderToStaticMarkup(<SampleDataSection viewer={viewer(role)} />)).toBe('');
    }
    expect(renderToStaticMarkup(<SampleDataSection viewer={null} />)).toBe('');
  });

  it('para OWNER la sección arranca en «cargando»', () => {
    const html = renderToStaticMarkup(<SampleDataSection viewer={viewer('OWNER')} />);
    expect(html).toContain('id="datos-de-ejemplo"');
    expect(html).toContain('Cargando los datos de ejemplo');
  });
});

describe('aviso de espacio de prueba', () => {
  it('solo si se cargaron y no se han borrado', () => {
    expect(shouldShowSampleNotice('OWNER', LOADED)).toBe(true);
    expect(shouldShowSampleNotice('OWNER', { ...LOADED, clearedAt: '2026-11-13T10:00:00.000Z', samplePatients: 0 })).toBe(false);
    expect(shouldShowSampleNotice('OWNER', { ...LOADED, loaded: false })).toBe(false);
    expect(shouldShowSampleNotice('OWNER', null)).toBe(false);
  });

  it('sin aviso fijo de entorno demo: el texto completo', () => {
    const html = renderToStaticMarkup(<SampleDataNoticeView demoBanner={false} dismissed={false} onDismiss={() => undefined} onReopen={() => undefined} />);
    expect(html).toContain(SAMPLE_NOTICE_TITLE);
    expect(html).toContain(SAMPLE_NOTICE_NO_REAL_DATA);
    expect(html).toContain('aria-label="Cerrar el aviso de espacio de prueba"');
  });

  it('con el aviso fijo «Entorno de prueba» no repite «No introduzcas datos reales»', () => {
    const html = renderToStaticMarkup(<SampleDataNoticeView demoBanner dismissed={false} onDismiss={() => undefined} onReopen={() => undefined} />);
    expect(html).toContain(SAMPLE_NOTICE_TITLE);
    expect(html).not.toContain(SAMPLE_NOTICE_NO_REAL_DATA);
  });

  it('explica por qué se le ha marcado como profesional que atiende (condición de Argos)', () => {
    for (const demoBanner of [true, false]) {
      const html = renderToStaticMarkup(<SampleDataNoticeView demoBanner={demoBanner} dismissed={false} onDismiss={() => undefined} onReopen={() => undefined} />);
      expect(html).toContain(SAMPLE_NOTICE_CLINICIAN);
    }
  });

  it('cerrado sigue localizable: enlace a «Datos de ejemplo» y botón para volver a verlo', () => {
    const html = renderToStaticMarkup(<SampleDataNoticeView demoBanner dismissed onDismiss={() => undefined} onReopen={() => undefined} />);
    expect(html).toContain('href="/settings/data#datos-de-ejemplo"');
    expect(html).toContain('Ver el aviso');
  });

  it('el cierre solo guarda una marca "1" por usuario, y tolera un almacenamiento bloqueado', () => {
    const storage = memoryStorage();
    setSampleNoticeDismissed('u1', true, storage);
    expect([...storage.data.values()]).toEqual(['1']);
    expect(isSampleNoticeDismissed('u1', storage)).toBe(true);
    expect(isSampleNoticeDismissed('u2', storage)).toBe(false);
    setSampleNoticeDismissed('u1', false, storage);
    expect(isSampleNoticeDismissed('u1', storage)).toBe(false);
    const broken = { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); }, removeItem: () => undefined };
    expect(isSampleNoticeDismissed('u1', broken)).toBe(false);
    expect(() => setSampleNoticeDismissed('u1', true, broken)).not.toThrow();
  });
});

describe('estado', () => {
  it('cuántos pacientes de ejemplo hay y desde cuándo', () => {
    expect(sampleStatusSummary(LOADED)).toBe('Hay 5 pacientes de ejemplo desde el 12 de noviembre de 2026.');
    expect(sampleStatusSummary({ ...LOADED, samplePatients: 1 })).toBe('Hay 1 paciente de ejemplo desde el 12 de noviembre de 2026.');
    expect(sampleStatusSummary({ ...LOADED, clearedAt: '2026-11-13T10:00:00.000Z', samplePatients: 0 })).toBe('Borraste los datos de ejemplo el 13 de noviembre de 2026.');
  });
});

describe('«Ver el portal como paciente»: la contraseña no persiste', () => {
  it('POST /sample-data/portal-access sin escribir en ningún almacenamiento del navegador', async () => {
    const local = memoryStorage();
    const session = memoryStorage();
    const g = globalThis as unknown as { window?: unknown; localStorage?: unknown; sessionStorage?: unknown };
    const previous = { window: g.window, localStorage: g.localStorage, sessionStorage: g.sessionStorage };
    g.localStorage = local; g.sessionStorage = session; g.window = { localStorage: local, sessionStorage: session };
    try {
      apiMock.mockResolvedValue(ACCESS);
      await expect(requestSamplePortalAccess()).resolves.toEqual(ACCESS);
      expect(apiMock).toHaveBeenCalledWith('/sample-data/portal-access', { method: 'POST' });
      expect(local.setItem).not.toHaveBeenCalled();
      expect(session.setItem).not.toHaveBeenCalled();
    } finally {
      Object.assign(g, previous);
    }
  });

  it('el código de la sección, del aviso y de su librería no usa localStorage/sessionStorage para la contraseña', () => {
    const root = join(__dirname, '..');
    for (const file of ['components/SampleDataSection.tsx', 'components/SampleDataNotice.tsx']) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
    const lib = readFileSync(join(root, 'lib/sample-data.ts'), 'utf8');
    // La librería solo toca localStorage para la marca de «aviso cerrado», nunca con la contraseña.
    expect(lib).not.toMatch(/setItem\([^)]*(temporaryPassword|password|email)/i);
  });

  it('las credenciales se muestran una vez, con aviso, copiar y enlace al portal; el QR no lleva la contraseña', () => {
    const portalUrl = `https://app.example.test${PORTAL_LOGIN_PATH}`;
    const html = renderToStaticMarkup(
      <SamplePortalCredentials access={ACCESS} portalUrl={portalUrl} copyStatus="" onCopy={() => undefined} onHide={() => undefined} />,
    );
    expect(html).toContain('Guárdala ahora: no se volverá a mostrar.');
    expect(html).toContain(ACCESS.email);
    expect(html).toContain(ACCESS.temporaryPassword);
    expect(html).toContain('Copiar contraseña');
    expect(html).toContain(`href="${PORTAL_LOGIN_PATH}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    // El QR es un SVG con trazado (sin texto); la contraseña solo aparece una vez (en su <code>).
    expect(html.split(ACCESS.temporaryPassword)).toHaveLength(2);
    expect(portalUrl).not.toContain(ACCESS.temporaryPassword);
  });

  it.each([
    [new ApiError('x', 404, 'SAMPLE_PORTAL_PATIENT_NOT_FOUND'), 'ya no existe'],
    [new ApiError('x', 409, 'SAMPLE_PORTAL_ACCESS_MODE_NOT_ALLOWED'), 'ya no tiene un acceso propio'],
    [new ApiError('x', 403), 'Solo la persona titular'],
    [new ApiError('x', 429), 'Espera un minuto'],
    [new ApiError('x', 401, 'SESSION_EXPIRED'), 'no se ha generado ninguna contraseña'],
    [new Error('red'), 'No hemos podido generar'],
  ])('error del acceso al portal → mensaje entendible (%#)', (err, text) => {
    expect(portalAccessErrorMessage(err)).toContain(text);
  });
});

describe('«Borrar los datos de ejemplo»', () => {
  it('envía la confirmación explícita { confirm: true }', async () => {
    apiMock.mockResolvedValue({ clearedAt: '2026-11-13T10:00:00.000Z', deleted: { patients: 5, sessions: 12, processes: 3 } });
    await clearSampleData();
    expect(apiMock).toHaveBeenCalledWith('/sample-data/clear', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  });

  it('el diálogo avisa de que es irreversible y de que no toca sus pacientes', () => {
    const html = renderToStaticMarkup(<ClearSampleDataDialog open samplePatients={5} busy={false} error="" onConfirm={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('¿Borrar los datos de ejemplo?');
    expect(html).toContain('los 5 pacientes de ejemplo');
    expect(html).toContain('No se puede deshacer.');
    expect(html).toContain('Los pacientes que hayas creado tú no se tocan.');
    expect(html).toContain('Sí, borrar los datos de ejemplo');
    expect(html).toContain('Cancelar');
  });

  it('cerrado no pinta contenido; borrando deshabilita los botones', () => {
    expect(renderToStaticMarkup(<ClearSampleDataDialog open={false} samplePatients={5} busy={false} error="" onConfirm={() => undefined} onClose={() => undefined} />)).not.toContain('Sí, borrar');
    const busy = renderToStaticMarkup(<ClearSampleDataDialog open samplePatients={5} busy error="" onConfirm={() => undefined} onClose={() => undefined} />);
    expect(busy).toContain('Borrando…');
    expect(busy.match(/disabled=""/g)).toHaveLength(3);
  });

  it('409 SAMPLE_DATA_NOT_PURGEABLE → mensaje entendible dentro del diálogo, sin borrar nada', () => {
    const message = clearErrorMessage(new ApiError('Conflict', 409, 'SAMPLE_DATA_NOT_PURGEABLE'));
    expect(message).toContain('No se ha borrado nada');
    expect(message).toContain('facturas emitidas');
    const html = renderToStaticMarkup(<ClearSampleDataDialog open samplePatients={5} busy={false} error={message} onConfirm={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('facturas emitidas');
  });

  it('sesión caducada en el POST: no se ha borrado nada, que vuelva a entrar', () => {
    expect(clearErrorMessage(new ApiError('x', 401, 'SESSION_EXPIRED'))).toBe('Tu sesión ha caducado y no se ha borrado nada. Inicia sesión de nuevo y vuelve a intentarlo.');
  });

  it('el resultado dice qué se ha borrado', () => {
    expect(clearResultMessage({ clearedAt: '2026-11-13T10:00:00.000Z', deleted: { patients: 5, sessions: 1, processes: 3 } }))
      .toBe('Listo. Se han borrado 5 pacientes, 1 cita y 3 procesos de ejemplo. Los pacientes que hayas creado tú siguen igual.');
  });
});
