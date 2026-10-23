import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { api, ApiError, resetSessionRedirectForTests, SESSION_REVOKED_LOGIN_URL } from '../lib/api';

/*
 * 401 SESSION_REVOKED (baja del equipo o contraseña cambiada): el cliente intenta renovar la sesión
 * UNA vez; si no se puede, va al login con un aviso. Nunca entra en bucle.
 */

type FakeResponse = { status: number; body: Record<string, unknown> };

const json = ({ status, body }: FakeResponse) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const revoked: FakeResponse = { status: 401, body: { statusCode: 401, code: 'SESSION_REVOKED', message: 'Tu sesión ya no es válida. Vuelve a iniciar sesión.' } };
const unauthorized: FakeResponse = { status: 401, body: { statusCode: 401, message: 'Unauthorized' } };

let assign: jest.Mock;
let fetchMock: jest.Mock;

function mockFetch(byPath: (path: string, call: number) => FakeResponse) {
  const counts = new Map<string, number>();
  fetchMock = jest.fn(async (input: unknown) => {
    const path = String(input).replace(/^https?:\/\/[^/]+\/api\/v1/, '');
    const call = (counts.get(path) ?? 0) + 1;
    counts.set(path, call);
    return json(byPath(path, call));
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
}

const calls = (path: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(path)).length;

beforeEach(() => {
  resetSessionRedirectForTests();
  assign = jest.fn();
  (globalThis as unknown as { window: unknown }).window = { location: { pathname: '/patients', assign } };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('401 SESSION_REVOKED', () => {
  it('intenta renovar una sola vez y, si falla, lleva al login con el aviso', async () => {
    mockFetch((path) => (path === '/auth/refresh' ? unauthorized : revoked));
    await expect(api('/patients')).rejects.toMatchObject({ status: 401, code: 'SESSION_REVOKED' });
    expect(calls('/auth/refresh')).toBe(1);
    expect(calls('/patients')).toBe(1);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(SESSION_REVOKED_LOGIN_URL);
  });

  it('si la renovación funciona, repite la petición y no redirige', async () => {
    mockFetch((path, call) => {
      if (path === '/auth/refresh') return { status: 200, body: { ok: true } };
      return call === 1 ? revoked : { status: 200, body: { data: [] } };
    });
    await expect(api('/patients')).resolves.toEqual({ data: [] });
    expect(calls('/auth/refresh')).toBe(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it('si tras renovar sigue revocada, no vuelve a renovar: va al login (sin bucle)', async () => {
    mockFetch((path) => (path === '/auth/refresh' ? { status: 200, body: { ok: true } } : revoked));
    await expect(api('/patients')).rejects.toBeInstanceOf(ApiError);
    expect(calls('/auth/refresh')).toBe(1);
    expect(calls('/patients')).toBe(2);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('varias peticiones a la vez provocan una sola redirección', async () => {
    mockFetch((path) => (path === '/auth/refresh' ? unauthorized : revoked));
    await Promise.allSettled([api('/patients'), api('/auth/me'), api('/agenda')]);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('en la propia pantalla de login no redirige', async () => {
    (globalThis as unknown as { window: { location: { pathname: string } } }).window.location.pathname = '/login';
    mockFetch((path) => (path === '/auth/refresh' ? unauthorized : revoked));
    await expect(api('/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(assign).not.toHaveBeenCalled();
  });

  it('un 401 corriente (sin SESSION_REVOKED) no redirige', async () => {
    mockFetch(() => unauthorized);
    await expect(api('/patients')).rejects.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();
  });

  it('el 401 del login (credenciales) nunca dispara la redirección ni la renovación', async () => {
    mockFetch(() => revoked);
    await expect(api('/auth/login', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(ApiError);
    expect(calls('/auth/refresh')).toBe(0);
    expect(assign).not.toHaveBeenCalled();
  });
});
