import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';

/*
 * Condición de Argos para «Tareas por revisar» (/follow-up/revisar): recepción (ASSISTANT) no pide
 * GET /dashboard (vista clínica, 403 para ese rol) y ve el aviso «Solo para profesionales».
 *
 * El entorno de jest es node (sin DOM): se sustituyen useState/useEffect para que el efecto de carga
 * corra de verdad, se fija el usuario (como lo traduciría GET /auth/me) y se registra cada llamada a
 * la API. Control: con un THERAPIST el mismo efecto sí llama a /dashboard. Datos ficticios.
 */

const effects: Array<() => unknown> = [];
jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useEffect: (fn: () => unknown) => { effects.push(fn); },
  };
});

const apiCalls: string[] = [];
jest.mock('../lib/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    api: async (path: string) => {
      apiCalls.push(path);
      return { attention: [] };
    },
  };
});

let me: Record<string, unknown> = {};
jest.mock('../lib/clinical', () => {
  const actual = jest.requireActual<typeof import('../lib/clinical')>('../lib/clinical');
  return { ...actual, useViewer: () => actual.viewerFromMe(me as never) };
});
jest.mock('../components/Sidebar', () => ({ __esModule: true, default: () => null }));
// Enlace simple: el de next/link registra sus propios efectos (prefetch), que aquí no interesan.
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children?: unknown }) => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return createElement('a', { href, ...rest }, children as never);
} }));

async function renderPage() {
  const { default: TasksToReviewPage } = await import('../app/follow-up/revisar/page');
  const html = renderToStaticMarkup(<TasksToReviewPage />);
  expect(effects.length).toBeGreaterThan(0);
  for (const effect of effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return html;
}

afterEach(() => {
  effects.length = 0;
  apiCalls.length = 0;
});

describe('«Tareas por revisar» con recepción (ASSISTANT)', () => {
  it('no llama a /dashboard y muestra «Solo para profesionales»', async () => {
    me = { userId: 'u-recepcion', role: 'ASSISTANT', isClinician: false, firstName: 'Recepción', lastName: 'Ficticia' };
    const html = await renderPage();
    expect(apiCalls.filter((path) => path.startsWith('/dashboard'))).toEqual([]);
    expect(html).toContain('Solo para profesionales');
    expect(html).not.toContain('Cargando tareas por revisar');
  });

  it('OWNER que no atiende pacientes: tampoco llama a /dashboard y ve el mismo aviso', async () => {
    me = { userId: 'u-titular', role: 'OWNER', isClinician: false, firstName: 'Titular', lastName: 'Ficticia' };
    const html = await renderPage();
    expect(apiCalls.filter((path) => path.startsWith('/dashboard'))).toEqual([]);
    expect(html).toContain('Solo para profesionales');
  });

  it('control: un THERAPIST sí carga /dashboard y no ve el aviso', async () => {
    me = { userId: 'u-terapeuta', role: 'THERAPIST', isClinician: true, firstName: 'Terapeuta', lastName: 'Ficticia' };
    const html = await renderPage();
    expect(apiCalls).toContain('/dashboard');
    expect(html).not.toContain('Solo para profesionales');
  });
});
