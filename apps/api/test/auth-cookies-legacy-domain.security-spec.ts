import { clearAuthCookies, setAuthCookies } from '../src/auth/cookie.util';

/*
 * Revisión de Argos (salida de Vercel): las cookies de sesión antiguas se emitieron con
 * Domain=COOKIE_DOMAIN. Si conviven con las nuevas host-only, cookie-parser se queda con la antigua
 * (revocada), auth.service lo toma como reutilización, revoca la familia y responde 401 en cada
 * refresh durante hasta 7 días. set/clear deben borrarlas con su mismo ámbito (domain + path).
 */
type Call = { kind: 'set' | 'clear'; n: string; o: any };
function fakeRes() {
  const calls: Call[] = [];
  const res: any = {
    cookie: (n: string, _v: string, o: any) => calls.push({ kind: 'set', n, o }),
    clearCookie: (n: string, o: any) => calls.push({ kind: 'clear', n, o }),
  };
  return { calls, res };
}
const params = () => ({ accessToken: 'a-ficticio', refreshToken: 'r-ficticio', refreshTokenExpiresAt: new Date(Date.now() + 60_000) });
const legacy = (calls: Call[]) => calls.filter((c) => c.kind === 'clear' && (c.n === 'access_token' || c.n === 'refresh_token') && c.o.domain !== undefined);

describe('Cookies de sesión antiguas con Domain: se limpian al emitir y al cerrar sesión', () => {
  const prev = process.env.COOKIE_DOMAIN;
  beforeEach(() => { process.env.COOKIE_DOMAIN = '.example.test'; });
  afterAll(() => { if (prev === undefined) delete process.env.COOKIE_DOMAIN; else process.env.COOKIE_DOMAIN = prev; });

  it('setAuthCookies (login, refresh, MFA) borra las antiguas con domain ANTES de poner las nuevas sin domain', () => {
    const { calls, res } = fakeRes();
    setAuthCookies(res, params());
    const old = legacy(calls);
    expect(old.map((c) => [c.n, c.o.domain, c.o.path])).toEqual([
      ['access_token', '.example.test', '/'],
      ['refresh_token', '.example.test', '/api/v1/auth'],
    ]);
    const sets = calls.filter((c) => c.kind === 'set' && (c.n === 'access_token' || c.n === 'refresh_token'));
    expect(sets.map((c) => [c.n, c.o.path])).toEqual([['access_token', '/'], ['refresh_token', '/api/v1/auth']]);
    for (const c of sets) expect(c.o.domain).toBeUndefined();
    const lastClear = Math.max(...old.map((c) => calls.indexOf(c)));
    expect(Math.min(...sets.map((c) => calls.indexOf(c)))).toBeGreaterThan(lastClear);
    // csrf_token no se toca aquí: se emite una sola vez, con COOKIE_DOMAIN.
    expect(calls.filter((c) => c.n === 'csrf_token').map((c) => c.kind)).toEqual(['set']);
  });

  it('clearAuthCookies (logout) borra las antiguas con domain y las nuevas host-only', () => {
    const { calls, res } = fakeRes();
    clearAuthCookies(res);
    expect(legacy(calls).map((c) => [c.n, c.o.domain, c.o.path])).toEqual([
      ['access_token', '.example.test', '/'],
      ['refresh_token', '.example.test', '/api/v1/auth'],
    ]);
    const hostOnly = calls.filter((c) => c.kind === 'clear' && (c.n === 'access_token' || c.n === 'refresh_token') && c.o.domain === undefined);
    expect(hostOnly.map((c) => [c.n, c.o.path])).toEqual([['access_token', '/'], ['refresh_token', '/api/v1/auth']]);
  });

  it('sin COOKIE_DOMAIN (local) no hay cookies antiguas que limpiar', () => {
    delete process.env.COOKIE_DOMAIN;
    const a = fakeRes();
    setAuthCookies(a.res, params());
    expect(a.calls.filter((c) => c.kind === 'clear')).toHaveLength(0);
    const b = fakeRes();
    clearAuthCookies(b.res);
    expect(legacy(b.calls)).toHaveLength(0);
  });
});
