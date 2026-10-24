import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformWaitlistEntryContract, PlatformWaitlistResponse } from '@asepsico/contracts';

jest.mock('next/navigation', () => ({ usePathname: () => '/', notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

import { resetSessionRedirectForTests } from '../lib/api';
import {
  applyFilters, commercialLabel, EMPTY_FILTERS, fetchIsPlatformAdmin, fieldView, formatSignupDate, invalidatePlatformAdmin,
  loadPanel, suppressEntry, suppressErrorMessage, weekLabel, withoutEntry,
} from '../lib/platform-waitlist';
import { Counters, EntriesTable, EntryCard } from '../components/WaitlistPanelParts';
import Sidebar from '../components/Sidebar';

/*
 * Panel privado de la lista de espera (/admin/lista-espera). Datos 100 % ficticios.
 * Se prueba con el cliente `api` real y un fetch simulado: así se comprueba también que la
 * supresión no renueva la sesión ni repite la petición con una contraseña incorrecta.
 */

type FakeResponse = { status: number; body?: Record<string, unknown> };
let fetchMock: jest.Mock;
const requests: { path: string; init: RequestInit }[] = [];

function mockFetch(byPath: (path: string, init: RequestInit) => FakeResponse) {
  requests.length = 0;
  fetchMock = jest.fn(async (input: unknown, init?: unknown) => {
    const path = String(input).replace(/^https?:\/\/[^/]+\/api\/v1/, '');
    const req = (init ?? {}) as RequestInit;
    requests.push({ path, init: req });
    const { status, body } = byPath(path, req);
    return status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
}

const notFoundBody = { statusCode: 404, message: 'Cannot GET /api/v1/admin/waitlist', error: 'Not Found' };

const entry = (over: Partial<PlatformWaitlistEntryContract> = {}): PlatformWaitlistEntryContract => ({
  id: 'wl-1',
  createdAt: '2026-10-22T08:15:00.000Z',
  isoWeek: '2026-W43',
  name: 'Profesional Ficticia Uno',
  email: 'ficticia.uno@example.com',
  situation: 'SELF_EMPLOYED',
  professionalsCount: 1,
  tools: 'Agenda en papel ficticia',
  source: 'PROFESSIONAL_COLLEGE',
  privacyPolicyVersion: 'lista-espera-v4',
  commercial: { status: 'NONE', at: null },
  unreadableFields: [],
  ...over,
});

const weekly = ['2026-W36', '2026-W37', '2026-W38', '2026-W39', '2026-W40', '2026-W41', '2026-W42', '2026-W43']
  .map((isoWeek, i) => ({ isoWeek, weekStart: `2026-${i < 4 ? '09' : '10'}-0${(i % 4) + 1}`, count: isoWeek === '2026-W43' ? 2 : isoWeek === '2026-W42' ? 1 : 0 }));

const panel = (): PlatformWaitlistResponse => ({
  entries: [
    entry(),
    entry({ id: 'wl-2', source: 'INSTAGRAM', situation: 'PRACTICE', name: null, unreadableFields: ['name'] }),
    entry({ id: 'wl-3', isoWeek: '2026-W42', createdAt: '2026-10-18T21:30:00.000Z', source: null, situation: null, privacyPolicyVersion: 'lista-espera-v2', commercial: { status: 'REQUESTED_UNCONFIRMED', at: '2026-10-16T10:00:00.000Z' } }),
  ],
  counters: {
    totalActive: 3,
    weekly,
    bySource: { INSTAGRAM: 1, COLLEAGUE: 0, PROFESSIONAL_COLLEGE: 1, SEARCH_ENGINE: 0, OTHER: 0, NOT_SAID: 0, UNSPECIFIED: 1 },
    bySituation: { SELF_EMPLOYED: 1, PRACTICE: 1, STUDENT: 0, OTHER: 0, UNSPECIFIED: 1 },
  },
  unreadable: 1,
  generatedAt: '2026-10-22T19:00:00.000Z',
});

beforeEach(() => {
  resetSessionRedirectForTests();
  invalidatePlatformAdmin();
  (globalThis as unknown as { window: unknown }).window = { location: { pathname: '/admin/lista-espera', assign: jest.fn() } };
  (globalThis as unknown as { document: unknown }).document = { cookie: 'csrf_token=csrf-ficticio' };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { document?: unknown }).document;
});

describe('Enlace del panel en la barra lateral', () => {
  it('solo es admin si /admin/me dice platformAdmin === true; cualquier error cuenta como "no"', async () => {
    mockFetch(() => ({ status: 200, body: { platformAdmin: false } }));
    expect(await fetchIsPlatformAdmin()).toBe(false);
    invalidatePlatformAdmin();
    mockFetch(() => ({ status: 500, body: {} }));
    expect(await fetchIsPlatformAdmin()).toBe(false);
    invalidatePlatformAdmin();
    mockFetch(() => ({ status: 200, body: { platformAdmin: 'true' } }));
    expect(await fetchIsPlatformAdmin()).toBe(false);
    invalidatePlatformAdmin();
    mockFetch(() => ({ status: 200, body: { platformAdmin: true } }));
    expect(await fetchIsPlatformAdmin()).toBe(true);
    expect(requests[0].init.cache).toBe('no-store');
  });

  it('la barra lateral no pinta el enlace mientras no se haya confirmado que es admin', () => {
    const html = renderToStaticMarkup(<Sidebar />);
    expect(html).not.toContain('/admin/lista-espera');
    expect(html).not.toContain('Lista de espera');
    expect(html).not.toContain('Administración');
  });
});

describe('Carga del panel y 404', () => {
  it('no admin (/admin/me false): 404 sin pedir la lista', async () => {
    mockFetch(() => ({ status: 200, body: { platformAdmin: false } }));
    expect(await loadPanel()).toEqual({ kind: 'notFound' });
    expect(requests.map((r) => r.path)).toEqual(['/admin/me']);
  });

  it('la API responde 404 a la lista: la web muestra su 404 normal', async () => {
    mockFetch((path) => (path === '/admin/me' ? { status: 200, body: { platformAdmin: true } } : { status: 404, body: notFoundBody }));
    expect(await loadPanel()).toEqual({ kind: 'notFound' });
  });

  it('sin sesión (401 tras intentar renovar): también 404, sin pistas', async () => {
    mockFetch(() => ({ status: 401, body: { statusCode: 401, message: 'Unauthorized' } }));
    expect(await loadPanel()).toEqual({ kind: 'notFound' });
  });

  it('error del servidor: se lanza para mostrar el estado de error con reintento (no un 404)', async () => {
    mockFetch(() => ({ status: 503, body: { message: 'Service Unavailable' } }));
    await expect(loadPanel()).rejects.toMatchObject({ status: 503 });
  });

  it('admin: devuelve la lista; las peticiones van con no-store', async () => {
    const data = panel();
    mockFetch((path) => (path === '/admin/me' ? { status: 200, body: { platformAdmin: true } } : { status: 200, body: data as unknown as Record<string, unknown> }));
    const result = await loadPanel();
    expect(result.kind).toBe('ready');
    expect(requests.every((r) => r.init.cache === 'no-store')).toBe(true);
  });
});

describe('Suprimir alta con contraseña', () => {
  it('POST /admin/waitlist/:id/delete con la contraseña en el cuerpo, CSRF y 204 sin cuerpo', async () => {
    mockFetch((path) => (path === '/admin/me' ? { status: 200, body: { platformAdmin: true } } : { status: 204 }));
    await expect(suppressEntry('wl-1', 'contraseña-ficticia')).resolves.toBeUndefined();
    const del = requests.find((r) => r.path === '/admin/waitlist/wl-1/delete')!;
    expect(del.init.method).toBe('POST');
    expect(JSON.parse(String(del.init.body))).toEqual({ password: 'contraseña-ficticia' });
    expect((del.init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-ficticio');
    expect(del.path).not.toContain('contrase');
    // Antes de suprimir se asegura la sesión: un token caducado no se confunde con "no existe".
    expect(requests[0].path).toBe('/admin/me');
  });

  it('contraseña incorrecta (401 PLATFORM_REAUTH_FAILED): no renueva la sesión ni repite el intento', async () => {
    mockFetch((path) => (path === '/admin/me'
      ? { status: 200, body: { platformAdmin: true } }
      : { status: 401, body: { statusCode: 401, code: 'PLATFORM_REAUTH_FAILED', message: 'No se ha podido confirmar' } }));
    let caught: unknown;
    await suppressEntry('wl-1', 'mal').catch((err) => { caught = err; });
    expect(requests.filter((r) => r.path.endsWith('/delete'))).toHaveLength(1);
    expect(requests.some((r) => r.path === '/auth/refresh')).toBe(false);
    expect(suppressErrorMessage(caught)).toBe('La contraseña no es correcta. No se ha suprimido nada.');
  });

  it('alta inexistente o ya suprimida (404) y límite de intentos (429) con mensajes claros', async () => {
    mockFetch((path) => (path === '/admin/me' ? { status: 200, body: { platformAdmin: true } } : { status: 404, body: notFoundBody }));
    const notFound = await suppressEntry('wl-x', 'x').catch((err) => err);
    expect(suppressErrorMessage(notFound)).toContain('ya no existe');
    mockFetch((path) => (path === '/admin/me' ? { status: 200, body: { platformAdmin: true } } : { status: 429, body: { message: 'ThrottlerException: Too Many Requests' } }));
    const throttled = await suppressEntry('wl-1', 'x').catch((err) => err);
    expect(suppressErrorMessage(throttled)).toContain('Espera un minuto');
    // Bloqueo temporal de la cuenta (los fallos cuentan como los del MFA): se muestra el texto de la API.
    mockFetch((path) => (path === '/admin/me' ? { status: 200, body: { platformAdmin: true } } : { status: 429, body: { statusCode: 429, message: 'Demasiados intentos fallidos. Espera 5 minutos antes de volver a intentarlo.' } }));
    const locked = await suppressEntry('wl-1', 'x').catch((err) => err);
    expect(suppressErrorMessage(locked)).toBe('Demasiados intentos fallidos. Espera 5 minutos antes de volver a intentarlo.');
  });

  it('el diálogo explica que es irreversible y pide la contraseña con su etiqueta', () => {
    const source = readFileSync(join(__dirname, '../components/WaitlistSuppressDialog.tsx'), 'utf8');
    expect(source).toContain('No se puede deshacer');
    expect(source).toContain('type="password"');
    expect(source).toContain('autoComplete="current-password"');
    expect(source).toContain('Tu contraseña de AsePsico');
  });

  it('tras suprimir, la fila desaparece y los contadores se recalculan', () => {
    const next = withoutEntry(panel(), 'wl-2');
    expect(next.entries.map((e) => e.id)).toEqual(['wl-1', 'wl-3']);
    expect(next.counters.totalActive).toBe(2);
    expect(next.counters.bySource.INSTAGRAM).toBe(0);
    expect(next.counters.bySituation.PRACTICE).toBe(0);
    expect(next.counters.weekly.find((w) => w.isoWeek === '2026-W43')!.count).toBe(1);
    expect(next.unreadable).toBe(0);
  });
});

describe('"No legible", formato y filtros', () => {
  it('un campo que no se pudo descifrar se muestra como "No legible" sin romper la tabla ni las tarjetas', () => {
    const unreadable = entry({ name: null, email: null, tools: null, unreadableFields: ['name', 'email', 'tools'] });
    expect(fieldView(unreadable, 'name')).toEqual({ text: 'No legible', unreadable: true });
    const table = renderToStaticMarkup(<EntriesTable entries={[unreadable, entry({ id: 'wl-ok' })]} onSuppress={() => undefined} />);
    expect(table.match(/No legible/g)).toHaveLength(3);
    expect(table).toContain('Profesional Ficticia Uno');
    expect(table.match(/<tr>/g)).toHaveLength(3); // cabecera + 2 filas
    const card = renderToStaticMarkup(<EntryCard entry={unreadable} onSuppress={() => undefined} />);
    expect(card.match(/No legible/g)).toHaveLength(3);
  });

  it('herramientas se truncan a 60 caracteres con el texto completo en el tooltip; sin dato = "—"', () => {
    const long = 'Agenda ficticia '.repeat(6);
    const view = fieldView(entry({ tools: long }), 'tools');
    expect(view.text.length).toBeLessThanOrEqual(60);
    expect(view.title).toBe(long);
    expect(fieldView(entry({ tools: null }), 'tools')).toEqual({ text: '—', unreadable: false });
  });

  it('fechas en hora de Madrid (un domingo a las 23:30 sigue siendo domingo)', () => {
    expect(formatSignupDate('2026-10-18T21:30:00.000Z')).toBe('18/10/2026 23:30');
    expect(weekLabel('2026-W43')).toBe('Semana 43 · 19–25 oct');
  });

  it('estado comercial con las etiquetas de la spec', () => {
    expect(commercialLabel({ status: 'NONE', at: null })).toBe('—');
    expect(commercialLabel({ status: 'REQUESTED_UNCONFIRMED', at: '2026-10-16T10:00:00.000Z' })).toBe('Solicitado (sin confirmar)');
    expect(commercialLabel({ status: 'VALID', at: '2026-10-20T10:00:00.000Z' })).toBe('Válido desde 20/10');
    expect(commercialLabel({ status: 'WITHDRAWN', at: '2026-10-21T10:00:00.000Z' })).toBe('Retirado 21/10');
  });

  it('filtros en el navegador: origen y situación múltiples, semana, y "No indicado" para los vacíos', () => {
    const { entries } = panel();
    expect(applyFilters(entries, EMPTY_FILTERS)).toHaveLength(3);
    expect(applyFilters(entries, { ...EMPTY_FILTERS, sources: ['PROFESSIONAL_COLLEGE'] }).map((e) => e.id)).toEqual(['wl-1']);
    expect(applyFilters(entries, { ...EMPTY_FILTERS, sources: ['PROFESSIONAL_COLLEGE', 'UNSPECIFIED'] }).map((e) => e.id)).toEqual(['wl-1', 'wl-3']);
    expect(applyFilters(entries, { ...EMPTY_FILTERS, situations: ['PRACTICE'] }).map((e) => e.id)).toEqual(['wl-2']);
    expect(applyFilters(entries, { ...EMPTY_FILTERS, week: '2026-W42' }).map((e) => e.id)).toEqual(['wl-3']);
  });

  it('los contadores pintan total, semanas y desgloses', () => {
    const html = renderToStaticMarkup(<Counters data={panel()} />);
    expect(html).toContain('Altas activas');
    expect(html).toContain('Últimas 8 semanas');
    expect(html).toContain('Colegio profesional');
    expect(html).toContain('Alta con datos no legibles');
  });
});

describe('Sin persistencia ni exportación', () => {
  const files = ['../lib/platform-waitlist.ts', '../app/admin/lista-espera/page.tsx', '../components/WaitlistPanelParts.tsx', '../components/WaitlistSuppressDialog.tsx'];
  it.each(files)('%s no usa storage, URL ni portapapeles', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|clipboard|searchParams|router\.push|\.csv|download/i);
  });

  it('la cabecera no dice "responsable: AsePsico"', () => {
    const source = readFileSync(join(__dirname, '../app/admin/lista-espera/page.tsx'), 'utf8');
    expect(source).toContain('Lista de espera · solo para administración de AsePsico');
    expect(source).not.toMatch(/responsable:\s*AsePsico/i);
  });
});

describe('404 propia en español', () => {
  it('not-found.tsx está en español y no menciona el panel', () => {
    const source = readFileSync(join(__dirname, '../app/not-found.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).toContain('No encontramos esta página');
    expect(source).not.toMatch(/lista de espera|admin/i);
  });
});
