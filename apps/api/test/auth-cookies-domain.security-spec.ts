import { clearAuthCookies, setAuthCookies } from '../src/auth/cookie.util';

/*
 * Condición de Argos (salida de Vercel): con la web en app.<dominio> y la API en api.<dominio>,
 * las cookies de sesión son host-only (solo las recibe la API). Únicamente csrf_token lleva
 * COOKIE_DOMAIN, para que la web pueda leerlo y reenviarlo en x-csrf-token.
 */
function fakeRes() {
  const set: Array<{ n: string; o: any }> = [];
  const cleared: Array<{ n: string; o: any }> = [];
  const res: any = { cookie: (n: string, _v: string, o: any) => set.push({ n, o }), clearCookie: (n: string, o: any) => cleared.push({ n, o }) };
  return { set, cleared, res };
}
// Con COOKIE_DOMAIN, set/clear también borran las cookies de sesión antiguas con Domain: hay dos
// entradas con el mismo nombre. byName coge la del ámbito pedido (sin domain por defecto).
const byName = (list: Array<{ n: string; o: any }>, n: string, withDomain = false) =>
  list.find((c) => c.n === n && (withDomain ? c.o.domain !== undefined : c.o.domain === undefined))!.o;

describe('Auth cookies: session host-only, only csrf_token with COOKIE_DOMAIN', () => {
  const prev = process.env.COOKIE_DOMAIN;
  beforeEach(() => { process.env.COOKIE_DOMAIN = '.example.test'; });
  afterAll(() => { if (prev === undefined) delete process.env.COOKIE_DOMAIN; else process.env.COOKIE_DOMAIN = prev; });

  it('access_token and refresh_token have no Domain even when COOKIE_DOMAIN is set', () => {
    const { set, res } = fakeRes();
    setAuthCookies(res, { accessToken: 'a-ficticio', refreshToken: 'r-ficticio', refreshTokenExpiresAt: new Date(Date.now() + 60_000) });
    expect(byName(set, 'access_token')).not.toHaveProperty('domain');
    expect(byName(set, 'refresh_token')).not.toHaveProperty('domain');
    expect(byName(set, 'access_token')).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(byName(set, 'refresh_token')).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/v1/auth' });
  });

  it('csrf_token uses COOKIE_DOMAIN and is readable by the web', () => {
    const { set, res } = fakeRes();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: new Date(Date.now() + 60_000) });
    expect(byName(set, 'csrf_token', true)).toMatchObject({ domain: '.example.test', httpOnly: false, sameSite: 'lax', path: '/' });
  });

  it('logout clears each cookie with the same scope it was set with', () => {
    const { cleared, res } = fakeRes();
    clearAuthCookies(res);
    expect(byName(cleared, 'access_token')).toMatchObject({ path: '/' });
    expect(byName(cleared, 'refresh_token')).toMatchObject({ path: '/api/v1/auth' });
    expect(byName(cleared, 'csrf_token', true)).toMatchObject({ domain: '.example.test', path: '/' });
    expect(cleared.filter((c) => c.n === 'csrf_token')).toHaveLength(1);
  });

  it('without COOKIE_DOMAIN (local) every cookie is host-only', () => {
    delete process.env.COOKIE_DOMAIN;
    const { set, res } = fakeRes();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: new Date(Date.now() + 60_000) });
    for (const n of ['access_token', 'refresh_token', 'csrf_token']) expect(byName(set, n).domain).toBeUndefined();
  });
});
