import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, ApiError, resetSessionRedirectForTests } from '../lib/api';
import { isPublicPath, loginHref, safeNextPath, sessionEndedLoginHref, termsHref } from '../lib/login-redirect';

/*
 * fix/enlace-email-sin-sesion: el botón del email al equipo abría una pantalla del área profesional
 * sin sesión y salía «No hemos podido preparar tu jornada», sin forma de iniciar sesión. Ahora el
 * 401 lleva a /login?next=<ruta> y se vuelve allí tras entrar. `next` es a prueba de open redirect.
 */

describe('safeNextPath: solo rutas internas del área profesional', () => {
  it.each([
    ['/', '/'],
    ['/agenda/solicitudes/', '/agenda/solicitudes/'],
    ['/follow-up/revisar/', '/follow-up/revisar/'],
    ['/patients/view/?id=ckabc1234567890abcdefgh', '/patients/view/?id=ckabc1234567890abcdefgh'],
    ['/patients/view/tasks/?id=ckabc1234567890abcdefgh&filtro=por-revisar', '/patients/view/tasks/?id=ckabc1234567890abcdefgh&filtro=por-revisar'],
    ['/terms?next=%2Fagenda%2Fsolicitudes%2F', '/terms?next=%2Fagenda%2Fsolicitudes%2F'],
    ['/portal-signups', '/portal-signups'],
  ])('acepta %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    // URLs absolutas y esquemas
    'https://evil.example',
    'http://evil.example/agenda',
    'HTTPS://evil.example',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    'mailto:alguien@example.test',
    'agenda/solicitudes', // relativa sin barra inicial
    './/evil.example',
    // protocol-relative y variantes con barra invertida
    '//evil.example',
    '///evil.example',
    '//evil.example/agenda',
    '/\\evil.example',
    '\\\\evil.example',
    '\\/evil.example',
    '/\\/evil.example',
    '/agenda\\..\\..\\evil',
    // codificadas
    '/%2F%2Fevil.example',
    '/%2fevil.example',
    '/%5Cevil.example',
    '/%5cevil.example',
    '/agenda/%5c%5cevil',
    '/%09/evil.example',
    '/%0a/evil.example',
    '/%00',
    // espacios y caracteres de control (el parser de URL se los salta: /\t/evil → //evil)
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    ' /agenda',
    '/agenda /x',
    '\u0000/agenda',
    '/ /evil.example',
    // otros caracteres fuera de la lista
    '/agenda"><script>',
    '/agenda<x>',
    '/agenda`x`',
    // pantallas públicas o del portal del paciente (y bucles con el login)
    '/login',
    '/login?next=/agenda',
    '/login/',
    '/register',
    '/join?token=x',
    '/legal',
    '/portal',
    '/portal/login',
    // panel oculto de plataforma (404 sin pistas)
    '/admin/lista-espera',
    // vacío, demasiado largo, tipos raros
    '',
    `/${'a'.repeat(600)}`,
  ])('rechaza %j', (input) => {
    expect(safeNextPath(input)).toBeNull();
  });

  it('rechaza lo que no es texto', () => {
    for (const value of [null, undefined, 42, {}, ['/agenda'], true]) expect(safeNextPath(value)).toBeNull();
  });

  it('normaliza ../ sin salir de la app', () => {
    expect(safeNextPath('/agenda/../patients')).toBe('/patients');
    expect(safeNextPath('/../../evil.example')).toBe('/evil.example');
    expect(safeNextPath('/agenda/../login')).toBeNull();
  });

  it('isPublicPath distingue /portal de /portal-signups', () => {
    expect(isPublicPath('/portal')).toBe(true);
    expect(isPublicPath('/portal/login/')).toBe(true);
    expect(isPublicPath('/portal-signups/')).toBe(false);
    expect(isPublicPath('/agenda/solicitudes/')).toBe(false);
  });
});

describe('loginHref / sessionEndedLoginHref / termsHref', () => {
  it('codifica el destino y lo descarta si no es seguro', () => {
    expect(loginHref('/agenda/solicitudes/')).toBe('/login?next=%2Fagenda%2Fsolicitudes%2F');
    expect(loginHref('//evil.example')).toBe('/login');
    expect(loginHref(null)).toBe('/login');
    expect(sessionEndedLoginHref('/patients')).toBe('/login?sesion=terminada&next=%2Fpatients');
    expect(sessionEndedLoginHref('https://evil.example')).toBe('/login?sesion=terminada');
  });

  it('termsHref no anida /terms dentro de /terms', () => {
    expect(termsHref('/terms', '/agenda/solicitudes/')).toBe('/terms?next=%2Fagenda%2Fsolicitudes%2F');
    expect(termsHref('/terms', '/terms')).toBe('/terms');
    expect(termsHref('/terms', '/terms?next=%2Fx')).toBe('/terms');
    expect(termsHref('/terms', 'javascript:alert(1)')).toBe('/terms');
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Cliente de la API: 401 sin sesión → login con next                                              */
/* --------------------------------------------------------------------------------------------- */

type FakeResponse = { status: number; body: Record<string, unknown> };
const json = ({ status, body }: FakeResponse) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const unauthorized: FakeResponse = { status: 401, body: { statusCode: 401, message: 'Unauthorized' } };

let assign: jest.Mock;
let fetchMock: jest.Mock;

function mockFetch(byPath: (path: string) => FakeResponse) {
  fetchMock = jest.fn(async (input: unknown) => json(byPath(String(input).replace(/^https?:\/\/[^/]+\/api\/v1/, ''))));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
}

function setLocation(pathname: string, search = '') {
  (globalThis as unknown as { window: unknown }).window = { location: { pathname, search, assign } };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetSessionRedirectForTests();
  assign = jest.fn();
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('api(): 401 de autenticación en el área profesional', () => {
  it('sin sesión (y sin poder renovarla) va al login conservando el destino, y no pinta error', async () => {
    setLocation('/agenda/solicitudes/');
    mockFetch(() => unauthorized);
    let settled = false;
    void api('/appointment-requests').then(() => { settled = true; }, () => { settled = true; });
    await tick();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fagenda%2Fsolicitudes%2F');
    // La promesa queda pendiente: ninguna pantalla muestra «No hemos podido…» mientras navega.
    expect(settled).toBe(false);
  });

  it('conserva la query (ids opacos) del destino', async () => {
    setLocation('/patients/view/tasks/', '?id=ckabc1234567890abcdefgh&filtro=por-revisar');
    mockFetch(() => unauthorized);
    void api('/auth/me');
    await tick();
    expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/patients/view/tasks/?id=ckabc1234567890abcdefgh&filtro=por-revisar')}`);
  });

  it('varias peticiones en paralelo: una sola redirección', async () => {
    setLocation('/');
    mockFetch(() => unauthorized);
    void api('/auth/me');
    void api('/dashboard');
    void api('/notifications');
    await tick();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/login?next=%2F');
  });

  it('si la renovación funciona, repite la petición y no redirige', async () => {
    setLocation('/');
    let calls = 0;
    mockFetch((path) => {
      if (path === '/auth/refresh') return { status: 200, body: {} };
      calls += 1;
      return calls === 1 ? unauthorized : { status: 200, body: { ok: true } };
    });
    await expect(api('/auth/me')).resolves.toEqual({ ok: true });
    expect(assign).not.toHaveBeenCalled();
  });

  it('en el login, el portal del paciente y las pantallas públicas no redirige: devuelve el error', async () => {
    for (const path of ['/login', '/portal', '/portal/login/', '/join', '/register', '/admin/lista-espera']) {
      resetSessionRedirectForTests();
      setLocation(path);
      mockFetch(() => unauthorized);
      await expect(api('/auth/me')).rejects.toBeInstanceOf(ApiError);
    }
    expect(assign).not.toHaveBeenCalled();
  });

  it('los 401 de negocio (contraseña o código incorrectos) no redirigen', async () => {
    setLocation('/settings/security');
    mockFetch(() => ({ status: 401, body: { statusCode: 401, message: 'Contraseña incorrecta' } }));
    await expect(api('/auth/change-password', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 401 });
    mockFetch(() => ({ status: 401, body: { statusCode: 401, code: 'PLATFORM_REAUTH_FAILED', message: 'x' } }));
    await expect(api('/platform/x', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 401 });
    mockFetch(() => ({ status: 401, body: { statusCode: 401, message: 'Código no válido' } }));
    await expect(api('/auth/login/mfa', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();
  });

  it('el 428 de condiciones nuevas lleva a /terms con el destino', async () => {
    setLocation('/agenda/solicitudes/');
    mockFetch(() => ({ status: 428, body: { statusCode: 428, code: 'TERMS_ACCEPTANCE_REQUIRED', message: 'x' } }));
    await expect(api('/appointment-requests')).rejects.toMatchObject({ status: 428 });
    expect(assign).toHaveBeenCalledWith('/terms?next=%2Fagenda%2Fsolicitudes%2F');
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Login y condiciones: vuelven al destino validado                                                */
/* --------------------------------------------------------------------------------------------- */

const WEB_ROOT = join(__dirname, '..');
const login = readFileSync(join(WEB_ROOT, 'app', 'login', 'page.tsx'), 'utf8');
const terms = readFileSync(join(WEB_ROOT, 'app', 'terms', 'page.tsx'), 'utf8');

describe('login y condiciones vuelven al destino', () => {
  it('el login lee next solo a través de la validación y lo usa tras contraseña y tras MFA', () => {
    expect(login).toMatch(/nextPath\.current = nextFromLocation\(\)/);
    expect(login).not.toMatch(/searchParams?\.get\('next'\)|params\.get\('next'\)/);
    expect(login).toMatch(/router\.push\(nextPath\.current \?\? DEFAULT_AFTER_LOGIN\)/);
    expect(login.match(/goAfterLogin\(\);/g)?.length).toBe(2);
    expect(login).not.toMatch(/router\.push\('\/patients'\)/);
  });

  it('las condiciones vuelven al destino validado (nunca a /terms)', () => {
    expect(terms).toMatch(/const next = nextFromLocation\(\)/);
    expect(terms).not.toMatch(/router\.push\('\/'\)/);
  });
});
