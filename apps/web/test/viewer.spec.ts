import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ApiError } from '../lib/api';

/*
 * Sustituye al e2e que pidió Argos (la web no tiene infraestructura de e2e): quién usa la web sale
 * de GET /auth/me para todos los roles; recepción no pide GET /dashboard (vista clínica) y su
 * "Mi jornada" no pinta conceptos de factura ni textos clínicos.
 */
const api = jest.fn<(path: string) => Promise<unknown>>();
jest.mock('../lib/api', () => {
  const actual = jest.requireActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, api: (path: string) => api(path) };
});

type ClinicalModule = typeof import('../lib/clinical');
function loadModule(): ClinicalModule {
  let mod!: ClinicalModule;
  jest.isolateModules(() => {
    mod = require('../lib/clinical') as ClinicalModule;
  });
  return mod;
}

const ME = {
  userId: 'u-1', email: 'recepcion@example.test', firstName: 'Lucía', lastName: 'Demo', role: 'ASSISTANT',
  isClinician: false, mfaEnabled: false, workspace: { id: 'ws-1', name: 'Consulta Demo' },
};

describe('fetchViewer (GET /auth/me)', () => {
  beforeEach(() => {
    api.mockReset();
  });

  it('recepción: nombre, rol y consulta desde /auth/me, sin llamar a /dashboard', async () => {
    api.mockResolvedValueOnce(ME);
    const viewer = await loadModule().fetchViewer();
    expect(viewer).toMatchObject({ role: 'ASSISTANT', isClinician: false, firstName: 'Lucía', lastName: 'Demo', workspaceName: 'Consulta Demo' });
    expect(api.mock.calls.map(([path]) => path)).toEqual(['/auth/me']);
  });

  it('OWNER no clínico no es clínico; THERAPIST siempre lo es', async () => {
    api.mockResolvedValueOnce({ ...ME, role: 'OWNER', isClinician: false });
    expect((await loadModule().fetchViewer()).isClinician).toBe(false);
    api.mockResolvedValueOnce({ ...ME, role: 'THERAPIST', isClinician: false });
    expect((await loadModule().fetchViewer()).isClinician).toBe(true);
  });

  it('MFA pendiente se detecta por el código, no por el texto', async () => {
    api.mockRejectedValueOnce(new ApiError('Cualquier texto', 403, 'MFA_SETUP_REQUIRED'));
    expect(await loadModule().fetchViewer()).toMatchObject({ role: null, mfaPending: true });
  });

  it('otro 403 (aunque hable de "dos pasos") no es MFA ni se toma por recepción', async () => {
    api.mockRejectedValueOnce(new ApiError('Activa la verificación en dos pasos antes de continuar', 403));
    const viewer = await loadModule().fetchViewer();
    expect(viewer.mfaPending).toBeUndefined();
    expect(viewer.role).toBeNull();
  });

  it('un rol desconocido no se adivina', async () => {
    api.mockResolvedValueOnce({ ...ME, role: 'PATIENT' });
    expect((await loadModule().fetchViewer()).role).toBeNull();
  });
});

describe('"Mi jornada" de recepción (revisión estática)', () => {
  const src = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');

  it('AdminDayView no llama a /dashboard ni pinta conceptos, líneas o notas', () => {
    const code = src('components/AdminDayView.tsx').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/['"`]\/dashboard/);
    expect(code).not.toMatch(/\.concept\b|\.lines\b|\.notes\b|description|consultationReason|internalSummary/);
  });

  it('la portada solo pide /dashboard en la vista clínica', () => {
    const code = src('app/page.tsx');
    const clinicalStart = code.indexOf('function ClinicalHome');
    expect(clinicalStart).toBeGreaterThan(0);
    expect(code.slice(0, clinicalStart)).not.toMatch(/api[^(]*\(\s*['"`]\/dashboard/);
    expect(code.slice(0, clinicalStart)).toMatch(/if \(!viewer\.isClinician\)/);
  });
});
