import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Arreglo A1 (petición de Argos): el portal del paciente ya no pide ni guarda «Preferencias de
 * avisos» (ofrecía correo y SMS, que hoy no se envían). La API no cambia; lo que se comprueba es que
 * la pantalla del portal no llama a /portal/notifications/preferences ni con GET ni con PATCH.
 *
 * El entorno de jest es node (sin DOM): se ejecuta el componente como función con useState/useEffect
 * sustituidos para que el efecto de carga corra de verdad y se registren todas las peticiones.
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
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));

const dashboard = {
  patient: { firstName: 'Paciente', lastName: 'Ficticio' },
  sessions: [], tasks: [], consents: [], invoices: [], resources: [], mustChangePassword: false,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  effects.length = 0;
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('Portal del paciente: sin «Preferencias de avisos» (A1)', () => {
  it('al cargar pide dashboard, avisos y mensajes, y nunca /portal/notifications/preferences', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/portal/dashboard')) return json(dashboard);
      if (url.endsWith('/portal/notifications')) return json([]);
      if (url.endsWith('/portal/messages')) return json(null);
      return json({});
    });

    const { default: PortalPage } = await import('../app/portal/page');
    PortalPage();
    expect(effects.length).toBeGreaterThan(0);
    for (const effect of effects) effect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const paths = calls.map((c) => c.url.replace(/^https?:\/\/[^/]+\/api\/v1/, ''));
    // Control: la carga llegó a la fase en la que antes se pedían las preferencias.
    expect(paths).toEqual(expect.arrayContaining(['/portal/dashboard', '/portal/notifications', '/portal/messages']));
    expect(paths.some((p) => p.includes('/notifications/preferences'))).toBe(false);
  });

  it('el código de la pantalla no contiene la ruta, el bloque ni los campos de correo/SMS', () => {
    const source = readFileSync(join(__dirname, '..', 'app', 'portal', 'page.tsx'), 'utf8');
    expect(source).not.toContain('notifications/preferences');
    expect(source).not.toContain('Preferencias de avisos');
    expect(source).not.toMatch(/smsEnabled|emailEnabled|savePreferences/);
  });
});
