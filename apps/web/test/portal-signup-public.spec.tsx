import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import QrPoster from '../components/QrPoster';
import {
  activatePortalAccount, activationUrl, intakeUrl, PublicRequestError, sendSignupRequest, submitSignupRequest, takeTokenFromLocation, tokenFromHash,
} from '../lib/portal-signup';

/* Condiciones de Argos sobre las páginas públicas del alta por QR (feat/s5-web). */

const TOKEN = 'A'.repeat(20) + 'b_-' + '9'.repeat(20);
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn(async () => new Response(JSON.stringify({ ok: true, message: 'Hemos recibido tu solicitud.' }), { status: 202 }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

function fakeWindow(href: { pathname: string; hash: string; search?: string }) {
  const location = { pathname: href.pathname, hash: href.hash, search: href.search ?? '' };
  const history = {
    replaceState: jest.fn((_data: unknown, _unused: string, url?: string) => {
      const [path, hash = ''] = String(url ?? '').split('#');
      location.pathname = path;
      location.hash = hash ? `#${hash}` : '';
    }),
  };
  return { location, history };
}

const minorBirthDate = () => {
  const d = new Date();
  return `${d.getUTCFullYear() - 15}-01-01`;
};

describe('/portal/alta', () => {
  it('con fecha de menor no se llama nunca a la API y se pasa al paso «minor»', async () => {
    const outcome = await sendSignupRequest(TOKEN, { firstName: 'Iker', lastName: 'Ejemplo', email: 'iker@example.test', phone: '', birthDate: minorBirthDate() });
    expect(outcome).toEqual({ step: 'minor' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con 17 años recién cumplidos tampoco (mínimo 18)', async () => {
    const d = new Date();
    const birth = `${d.getUTCFullYear() - 17}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    await expect(sendSignupRequest(TOKEN, { firstName: 'A', lastName: 'B', email: 'a@example.test', phone: '', birthDate: birth })).resolves.toEqual({ step: 'minor' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el token se quita de la URL al montar', () => {
    const win = fakeWindow({ pathname: '/portal/alta', hash: `#t=${TOKEN}` });
    expect(takeTokenFromLocation(win)).toBe(TOKEN);
    expect(win.history.replaceState).toHaveBeenCalledWith(null, '', '/portal/alta');
    expect(win.location.hash).toBe('');
  });
});

describe('publicPost (endpoints públicos)', () => {
  it('va sin cookies, sin referrer y nunca con X-CSRF-Token aunque haya sesión del personal', async () => {
    (globalThis as unknown as { document: unknown }).document = { cookie: 'csrf_token=abc123; access_token=x' };
    await submitSignupRequest({
      token: TOKEN, firstName: 'Ana', lastName: 'Ejemplo', email: 'ana@example.test', birthDate: '1990-01-01',
      privacyNoticeAcknowledged: true, portalTermsAccepted: true, privacyNoticeVersion: 'v', portalTermsVersion: 'v',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    const headers = Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase());
    expect(headers).not.toContain('x-csrf-token');
  });
});

describe('/portal/activar', () => {
  it('tras montar y tras un fallo de red, la URL ya no lleva el token', async () => {
    const win = fakeWindow({ pathname: '/portal/activar', hash: `#t=${TOKEN}` });
    const token = takeTokenFromLocation(win);
    expect(win.location.hash).toBe('');
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    await expect(activatePortalAccount({ token: token!, password: 'EjemploSegura2026' })).rejects.toBeInstanceOf(PublicRequestError);
    expect(win.location.hash).toBe('');
  });
});

describe('tokenFromHash', () => {
  it('solo acepta el token en el fragmento, nunca en ?t=', () => {
    expect(tokenFromHash(`?t=${TOKEN}`)).toBeNull();
    const win = fakeWindow({ pathname: '/portal/alta', hash: '', search: `?t=${TOKEN}` });
    expect(takeTokenFromLocation(win)).toBeNull();
    expect(tokenFromHash(`#t=${TOKEN}`)).toBe(TOKEN);
  });
});

describe('Cartel imprimible', () => {
  it('.ps-print-area no contiene el nombre del profesional ni el enlace', () => {
    const url = `https://app.example.test/portal/alta#t=${TOKEN}`;
    const html = renderToStaticMarkup(<QrPoster value={url} />);
    expect(html).toContain('ps-print-area');
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain('app.example.test');
    expect(html).not.toMatch(/portal\/alta/);
    expect(html).not.toMatch(/Marta|Psicóloga|Ficticio/);
  });
});

describe('Enlaces del QR y de activación (sitio estático)', () => {
  it('llevan barra final antes del fragmento y el token solo en el fragmento', () => {
    expect(intakeUrl('https://app.example.test', TOKEN)).toBe(`https://app.example.test/portal/alta/#t=${TOKEN}`);
    expect(activationUrl('https://app.example.test', TOKEN)).toBe(`https://app.example.test/portal/activar/#t=${TOKEN}`);
  });
});
