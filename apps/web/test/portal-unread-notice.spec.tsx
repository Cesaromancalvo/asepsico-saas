import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/*
 * Aviso «Tu cita ha cambiado» arriba del portal del paciente (app/portal/page.tsx, clase
 * portal-unread-notice; hallazgo bajo de Argos del 03/11: el aviso no tenía test). Se comprueba:
 *  - solo aparece si hay avisos sin leer, y desaparece cuando todos están leídos;
 *  - muestra el primero sin leer (título y texto) y el recuento en singular o plural;
 *  - enlaza SIEMPRE al ancla #notificaciones del propio portal, nunca al actionUrl del aviso
 *    (aunque llegue un javascript: o una URL externa);
 *  - título y texto se pintan como texto escapado (nada de HTML inyectado);
 *  - el aviso no añade datos que el portal no tenga: solo título y texto del aviso.
 *
 * El entorno de jest es node (sin DOM): useState se sustituye por una cola con el estado de la
 * pantalla (data, items, conversation, error, message, busy, en ese orden) y useEffect no corre.
 * Datos 100 % ficticios.
 */

const stateQueue: unknown[] = [];
jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (init: unknown) => [stateQueue.length ? stateQueue.shift() : typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useEffect: () => undefined,
  };
});
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));
// La reserva de citas tiene su propio estado y sus propios tests: fuera de este render.
jest.mock('@/components/PortalBooking', () => ({ __esModule: true, default: () => null }));

type Notice = { id: string; title: string; body: string; status: string; createdAt: string; actionUrl?: string };

const dashboard = {
  patient: { firstName: 'Paciente', lastName: 'Ficticio' },
  sessions: [], tasks: [], consents: [], invoices: [], resources: [], mustChangePassword: false,
};

const moved = (over: Partial<Notice> = {}): Notice => ({
  id: 'n-moved', title: 'Tu cita ha cambiado', body: 'Tu cita ha cambiado: nueva fecha martes, 10 de noviembre, 10:00.',
  status: 'SENT', createdAt: '2026-11-08T09:00:00.000Z', actionUrl: '/portal', ...over,
});
const message = (over: Partial<Notice> = {}): Notice => ({
  id: 'n-msg', title: 'Nuevo mensaje', body: 'Tienes un nuevo mensaje de tu profesional.',
  status: 'SENT', createdAt: '2026-11-07T09:00:00.000Z', actionUrl: '/portal', ...over,
});

async function render(items: Notice[]) {
  const { default: PortalPage } = await import('../app/portal/page');
  stateQueue.push(dashboard, items, null, '', '', false);
  return renderToStaticMarkup(createElement(PortalPage));
}

/** El bloque del aviso (el <a class="portal-unread-notice"> completo) o null si no se pinta. */
function noticeBlock(html: string): string | null {
  const match = html.match(/<a[^>]*class="portal-unread-notice"[\s\S]*?<\/a>/);
  return match ? match[0] : null;
}

afterEach(() => { stateQueue.length = 0; });

describe('Portal del paciente: aviso de avisos sin leer (p. ej. «Tu cita ha cambiado»)', () => {
  it('sin avisos no se pinta', async () => {
    const html = await render([]);
    expect(html).toContain('Hola, Paciente'); // control: la pantalla se ha pintado
    expect(noticeBlock(html)).toBeNull();
  });

  it('con todos los avisos leídos no se pinta (aunque siguen en la tarjeta de notificaciones)', async () => {
    const html = await render([moved({ status: 'READ' }), message({ status: 'READ' })]);
    expect(noticeBlock(html)).toBeNull();
    expect(html).toContain('id="notificaciones"');
    expect(html).toContain('Tu cita ha cambiado');
  });

  it('un aviso sin leer: título, texto, singular y enlace a #notificaciones', async () => {
    const block = noticeBlock(await render([moved()]))!;
    expect(block).not.toBeNull();
    expect(block).toContain('href="#notificaciones"');
    expect(block).toContain('<strong>Tu cita ha cambiado</strong>');
    expect(block).toContain('nueva fecha martes, 10 de noviembre, 10:00.');
    expect(block).toContain('aria-label="Tienes 1 aviso nuevo: Tu cita ha cambiado. Ver notificaciones"');
    expect(block).not.toMatch(/aviso(s)? más/);
  });

  it('muestra el primero sin leer, salta los leídos y cuenta los demás («y 1 aviso más»)', async () => {
    const block = noticeBlock(await render([message({ id: 'n-read', status: 'READ', title: 'Aviso ya leído' }), moved(), message()]))!;
    expect(block).toContain('<strong>Tu cita ha cambiado</strong>');
    expect(block).not.toContain('Aviso ya leído');
    expect(block).toContain('Tienes 2 avisos nuevos: Tu cita ha cambiado');
    expect(block).toContain('y 1 aviso más');
  });

  it('plural con tres o más («y 2 avisos más»)', async () => {
    const block = noticeBlock(await render([moved(), message(), message({ id: 'n-3', title: 'Otro aviso' })]))!;
    expect(block).toContain('Tienes 3 avisos nuevos');
    expect(block).toContain('y 2 avisos más');
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['una URL externa', 'https://example.com/phishing'],
    ['una ruta del panel de staff', '/agenda'],
  ])('el enlace es siempre #notificaciones aunque el actionUrl sea %s', async (_label, actionUrl) => {
    const block = noticeBlock(await render([moved({ actionUrl })]))!;
    const hrefs = [...block.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['#notificaciones']);
    expect(block).not.toContain(actionUrl);
  });

  it('título y texto se pintan escapados: no se inyecta HTML', async () => {
    const block = noticeBlock(await render([moved({ title: '<img src=x onerror=alert(1)>', body: '<script>alert(1)</script>' })]))!;
    expect(block).not.toContain('<img');
    expect(block).not.toContain('<script');
    expect(block).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(block).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('el aviso solo usa el título y el texto: ni id, ni estado, ni fechas internas, ni actionUrl', async () => {
    const block = noticeBlock(await render([moved({ id: 'MARK-ID-AVISO', createdAt: '2026-11-08T09:00:00.000Z', actionUrl: '/MARK-ACTION' })]))!;
    expect(block).not.toContain('MARK-ID-AVISO');
    expect(block).not.toContain('MARK-ACTION');
    expect(block).not.toContain('SENT');
    expect(block).not.toContain('2026-11-08');
  });

  it('el código del aviso no usa dangerouslySetInnerHTML ni el actionUrl', () => {
    const source = readFileSync(join(__dirname, '..', 'app', 'portal', 'page.tsx'), 'utf8');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    const line = source.split('\n').find((l) => l.includes('portal-unread-notice'));
    expect(line).toBeDefined();
    expect(line).toContain('href="#notificaciones"');
    expect(line).not.toContain('actionUrl');
  });
});
