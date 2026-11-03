import { describe, expect, it, jest } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StaffNotification } from '@asepsico/contracts';

/*
 * Test de componente del desplegable de la campana (PanelContent). Mismo patrón que el resto de
 * apps/web/test: entorno node + renderToStaticMarkup, sin DOM ni librerías de testing. Lo que se
 * comprueba es el HTML que ve el profesional en cada estado; la navegación y el marcado como leído
 * (openNotice, markAll…) ya están cubiertos en staff-notifications.spec.tsx.
 * Datos ficticios.
 */

jest.mock('../lib/api', () => ({ api: () => Promise.resolve({}) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }), usePathname: () => '/' }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children?: unknown }) => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return createElement('a', { href, ...rest }, children as never);
} }));

import { NotificationPanel, PanelContent } from '../components/NotificationBell';
import type { BellState } from '../components/NotificationBell';

const NOW = '2026-11-12T12:00:00.000Z';
const SLOT_FROM = { startsAt: '2026-11-10T09:00:00.000Z', endsAt: '2026-11-10T09:50:00.000Z' };
const SLOT_TO = { startsAt: '2026-11-12T18:30:00.000Z', endsAt: '2026-11-12T19:20:00.000Z' };

function notice(over: Partial<StaffNotification> = {}, change: Partial<NonNullable<StaffNotification['appointmentChange']>> | null = {}): StaffNotification {
  return {
    id: 'n1', type: 'SYSTEM', title: 'Cita movida', body: 'Se ha movido tu cita con Paciente Uno.', actionUrl: '/agenda',
    status: 'SENT', scheduledAt: NOW, sentAt: NOW, readAt: null, createdAt: NOW,
    appointmentChange: change === null ? null : {
      change: 'RESCHEDULED_BY_STAFF', requestType: null, patient: { id: 'pac-ficticio-1', firstName: 'Paciente', lastName: 'Uno' },
      sessionId: 'sess-ficticia-1', requestId: null, from: SLOT_FROM, to: SLOT_TO, ...change,
    },
    ...over,
  };
}

const noop = () => undefined;
function bell(patch: Partial<Omit<BellState, 'list'>> & { state?: BellState['list']['state']; items?: StaffNotification[] } = {}): BellState {
  const { state = 'ready', items = [], ...rest } = patch;
  return {
    count: items.filter((n) => !n.readAt).length, open: true, list: { state, items }, busy: false, error: '',
    toggle: noop, close: noop, loadList: async () => undefined, markAll: async () => undefined, markOne: async () => undefined,
    openerRef: { current: null },
    ...rest,
  } as BellState;
}

const render = (b: BellState) => renderToStaticMarkup(<PanelContent bell={b} id="avisos" />);
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('Campana: desplegable de avisos', () => {
  it('es un diálogo no modal con id (aria-controls del botón) y título accesible', () => {
    const html = render(bell());
    expect(html).toMatch(/<div[^>]*id="avisos"[^>]*role="dialog"[^>]*aria-modal="false"[^>]*aria-labelledby="([^"]+)"/);
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)![1];
    expect(html).toContain(`id="${labelledBy}" tabindex="-1">Avisos</h2>`);
    expect(html).toContain('aria-label="Cerrar avisos"');
    expect(html).toContain('href="/notifications"');
    expect(html).toContain('Ver todos los avisos');
  });

  it('cargando: mensaje de estado, sin lista', () => {
    const html = render(bell({ state: 'loading' }));
    expect(html).toContain('role="status">Cargando avisos…');
    expect(html).not.toContain('bell-list');
  });

  it('error al cargar: alerta con botón Reintentar', () => {
    const html = render(bell({ state: 'error' }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('No se han podido cargar los avisos');
    expect(html).toContain('>Reintentar</button>');
  });

  it('sin avisos: estado vacío y «Marcar todos» desactivado', () => {
    const html = render(bell({ count: 0 }));
    expect(html).toContain('No tienes avisos');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Marcar todos como leídos<\/button>/);
  });

  it('error al marcar: se anuncia como alerta', () => {
    const html = render(bell({ items: [notice()], error: 'No se han podido marcar como leídos. Inténtalo de nuevo.' }));
    expect(html).toContain('<p class="bell-error" role="alert">No se han podido marcar como leídos.');
  });

  it('marcando: botón ocupado y desactivado', () => {
    const html = render(bell({ items: [notice()], busy: true }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Marcando…<\/button>/);
  });

  it('cambio de cita sin leer: chip del tipo, texto de la API, «Sin leer» para lector de pantalla y botón a la agenda', () => {
    const html = render(bell({ items: [notice()] }));
    expect(html).toContain('class="ui-chip chip-violet">Cita movida</span>');
    expect(html).toContain('Se ha movido tu cita con Paciente Uno.');
    expect(html).toContain('<span class="sr-only">Sin leer. </span>');
    expect(html).toContain('bell-item is-unread');
    expect(html).toMatch(/<button type="button" class="bell-item-main">[\s\S]*Ver en la agenda/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Marcar todos como leídos/);
  });

  it('aviso leído: sin punto de no leído ni texto «Sin leer»', () => {
    const html = render(bell({ items: [notice({ readAt: NOW, status: 'READ' })], count: 0 }));
    expect(html).not.toContain('is-unread');
    expect(html).not.toContain('Sin leer');
  });

  it('peticiones del paciente: chip rojo (cancelar) o ámbar (cambiar) y «Ver solicitud»', () => {
    const html = render(bell({ items: [notice({}, { change: 'PATIENT_REQUESTED_CANCEL', requestId: 'req-ficticia-1' })] }));
    expect(html).toContain('class="ui-chip chip-red">Pide cancelar la cita</span>');
    expect(html).toContain('Ver solicitud');
    const amber = render(bell({ items: [notice({}, { change: 'PATIENT_REQUESTED_RESCHEDULE', requestId: 'req-ficticia-1' })] }));
    expect(amber).toContain('class="ui-chip chip-amber">Pide cambiar la cita</span>');
  });

  it('aviso sin destino y sin leer: no es pulsable y ofrece «Marcar como leído»', () => {
    const html = render(bell({ items: [notice({ title: 'Aviso de la consulta', body: 'Texto ficticio.', actionUrl: null }, null)] }));
    expect(html).toContain('<strong>Aviso de la consulta</strong>');
    expect(html).toContain('bell-item-main is-static');
    expect(html).not.toContain('class="bell-item-main"');
    expect(html).toContain('>Marcar como leído</button>');
  });

  it('aviso sin destino ya leído: sin botón de marcar', () => {
    const html = render(bell({ items: [notice({ actionUrl: null, readAt: NOW, status: 'READ' }, null)], count: 0 }));
    expect(html).not.toContain('Marcar como leído</button>');
  });

  it('enlace externo en un aviso: no se convierte en botón de navegación', () => {
    const html = render(bell({ items: [notice({ actionUrl: 'https://evil.example' }, null)] }));
    expect(html).toContain('bell-item-main is-static');
    expect(html).not.toContain('evil.example');
  });

  it('muestra como mucho 8 avisos', () => {
    const items = Array.from({ length: 12 }, (_, i) => notice({ id: `n${i}` }));
    const html = render(bell({ items }));
    expect(count(html, '<li class="bell-item')).toBe(8);
  });

  it('privacidad: no expone ids de paciente, cita o solicitud ni datos en enlaces', () => {
    const html = render(bell({ items: [
      notice(),
      notice({ id: 'n2' }, { change: 'PATIENT_REQUESTED_RESCHEDULE', requestId: 'req-ficticia-1' }),
      notice({ id: 'n3', actionUrl: '/patients/view/?id=pac-ficticio-1' }, { patient: null, sessionId: null, requestId: null, from: null, to: null }),
    ] }));
    for (const id of ['pac-ficticio-1', 'sess-ficticia-1', 'req-ficticia-1']) expect(html).not.toContain(id);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['/notifications']);
  });
});

describe('Campana: NotificationPanel', () => {
  it('en el render de servidor (sin montar) no pinta nada aunque esté abierto', () => {
    expect(renderToStaticMarkup(<NotificationPanel bell={bell({ items: [notice()] })} id="avisos" />)).toBe('');
  });
});
