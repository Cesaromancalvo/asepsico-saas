import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StaffNotification } from '@asepsico/contracts';

const apiMock = jest.fn<(path: string, init?: RequestInit, options?: unknown) => Promise<unknown>>();
jest.mock('../lib/api', () => ({ api: (...args: [string, RequestInit?, unknown?]) => apiMock(...args) }));

import { BellButton } from '../components/NotificationBell';
import type { BellState } from '../components/NotificationBell';
import { setAgendaFocus, takeAgendaFocus } from '../lib/agenda-focus';
import {
  AGENDA_PATH,
  badgeText,
  CHANGE_LABEL,
  fetchUnreadCount,
  isUnread,
  markAllNotificationsRead,
  noticeTarget,
  openNotice,
  relativeTime,
  REQUESTS_PATH,
  unreadLabel,
} from '../lib/staff-notifications';

const SLOT_FROM = { startsAt: '2026-11-10T09:00:00.000Z', endsAt: '2026-11-10T09:50:00.000Z' };
const SLOT_TO = { startsAt: '2026-11-12T18:30:00.000Z', endsAt: '2026-11-12T19:20:00.000Z' };

function notice(over: Partial<StaffNotification> = {}, change: Partial<NonNullable<StaffNotification['appointmentChange']>> | null = {}): StaffNotification {
  return {
    id: 'n1', type: 'SYSTEM', title: 'Cita movida', body: 'Se ha movido tu cita con Paciente Uno.', actionUrl: '/agenda',
    status: 'SENT', scheduledAt: SLOT_FROM.startsAt, sentAt: SLOT_FROM.startsAt, readAt: null, createdAt: SLOT_FROM.startsAt,
    appointmentChange: change === null ? null : {
      change: 'RESCHEDULED_BY_STAFF', requestType: null, patient: { id: 'p1', firstName: 'Paciente', lastName: 'Uno' },
      sessionId: 'sess1', requestId: null, from: SLOT_FROM, to: SLOT_TO, ...change,
    },
    ...over,
  };
}

beforeEach(() => {
  apiMock.mockReset();
  takeAgendaFocus(); // limpia lo que haya quedado
});

describe('destino de un aviso', () => {
  it('cita movida → su semana en la agenda, con la hora nueva', () => {
    expect(noticeTarget(notice())).toEqual({ kind: 'agenda', label: 'Ver en la agenda', sessionId: 'sess1', startsAt: SLOT_TO.startsAt });
  });

  it('cita cancelada (sin hora nueva) → la hora anterior', () => {
    const target = noticeTarget(notice({}, { change: 'CANCELLED_BY_STAFF', to: null }));
    expect(target).toMatchObject({ kind: 'agenda', startsAt: SLOT_FROM.startsAt });
  });

  it('petición del paciente pendiente → bandeja de Solicitudes', () => {
    for (const change of ['PATIENT_REQUESTED_RESCHEDULE', 'PATIENT_REQUESTED_CANCEL'] as const) {
      expect(noticeTarget(notice({}, { change, requestId: 'r1' }))).toEqual({ kind: 'requests', label: 'Ver solicitud', href: REQUESTS_PATH });
    }
  });

  it('cita que el lector no puede ver (datos a null) → nunca a otra pantalla que la agenda', () => {
    const hidden = { patient: null, sessionId: null, requestId: null, from: null, to: null };
    expect(noticeTarget(notice({ actionUrl: '/patients/view/?id=abc' }, hidden))).toEqual({ kind: 'link', label: 'Abrir', href: AGENDA_PATH });
    expect(noticeTarget(notice({ actionUrl: null }, hidden))).toBeNull();
  });

  it('avisos que no son de cita: solo enlaces internos', () => {
    expect(noticeTarget(notice({ actionUrl: '/settings/team' }, null))).toEqual({ kind: 'link', label: 'Abrir', href: '/settings/team' });
    expect(noticeTarget(notice({ actionUrl: '//evil.example' }, null))).toBeNull();
    expect(noticeTarget(notice({ actionUrl: 'https://evil.example' }, null))).toBeNull();
  });

  it('cada tipo de cambio tiene su etiqueta, sin datos del paciente', () => {
    expect(Object.keys(CHANGE_LABEL)).toHaveLength(7);
    for (const label of Object.values(CHANGE_LABEL)) expect(label).not.toMatch(/Paciente|\d/);
  });
});

describe('pulsar un aviso', () => {
  it('marca como leído y lleva a la agenda sin datos en la URL; la cita a resaltar va en memoria', async () => {
    apiMock.mockResolvedValue({ ok: true });
    const push = jest.fn<(href: string) => void>();
    await openNotice(notice(), push);
    expect(apiMock).toHaveBeenCalledWith('/notifications/n1/read', { method: 'PATCH' });
    expect(push).toHaveBeenCalledWith('/agenda/');
    expect(push.mock.calls[0][0]).not.toMatch(/[?#]/);
    expect(takeAgendaFocus()).toEqual({ sessionId: 'sess1', startsAt: SLOT_TO.startsAt });
    expect(takeAgendaFocus()).toBeNull(); // se consume una sola vez
  });

  it('si falla el marcado, navega igual', async () => {
    apiMock.mockRejectedValue(new Error('red'));
    const push = jest.fn<(href: string) => void>();
    await openNotice(notice({}, { change: 'PATIENT_REQUESTED_CANCEL', requestId: 'r1' }), push);
    expect(push).toHaveBeenCalledWith(REQUESTS_PATH);
  });

  it('un aviso ya leído no se vuelve a marcar', async () => {
    const push = jest.fn<(href: string) => void>();
    await openNotice(notice({ readAt: SLOT_FROM.startsAt, status: 'READ' }), push);
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe('foco de la agenda', () => {
  it('caduca a los 30 s', () => {
    setAgendaFocus('sess1', SLOT_TO.startsAt);
    expect(takeAgendaFocus(Date.now() + 31_000)).toBeNull();
  });
});

describe('contador y API', () => {
  it('lee el contador y marca todos', async () => {
    apiMock.mockResolvedValueOnce({ unread: 3 });
    await expect(fetchUnreadCount()).resolves.toBe(3);
    // Refresco de fondo: sin sesión no navega al login (no se pierde lo escrito).
    expect(apiMock).toHaveBeenLastCalledWith('/notifications/unread-count', {}, { background: true });
    apiMock.mockResolvedValueOnce({ ok: true, updated: 2 });
    await expect(markAllNotificationsRead()).resolves.toBe(2);
    expect(apiMock).toHaveBeenLastCalledWith('/notifications/read-all', { method: 'POST' });
  });

  it('textos del contador', () => {
    expect(unreadLabel(0)).toBe('Sin avisos nuevos');
    expect(unreadLabel(1)).toBe('1 aviso sin leer');
    expect(unreadLabel(4)).toBe('4 avisos sin leer');
    expect(badgeText(120)).toBe('99+');
    expect(isUnread({ readAt: null, status: 'SENT' })).toBe(true);
  });

  it('tiempo relativo', () => {
    const now = new Date('2026-11-12T12:00:00.000Z');
    expect(relativeTime('2026-11-12T11:55:00.000Z', now)).toBe('hace 5 min');
    expect(relativeTime('2026-11-12T09:00:00.000Z', now)).toBe('hace 3 h');
  });
});

describe('botón de la campana', () => {
  const bell = (count: number, open = false) => ({ count, open, toggle: () => undefined } as unknown as BellState);

  it('anuncia el número de avisos sin leer y si está abierto', () => {
    const html = renderToStaticMarkup(<BellButton bell={bell(3, true)} placement="sidebar" controlsId="avisos" />);
    expect(html).toContain('aria-label="Avisos. 3 avisos sin leer"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="avisos"');
    expect(html).toContain('>3</span>');
  });

  it('sin avisos no pinta el globo', () => {
    const html = renderToStaticMarkup(<BellButton bell={bell(0)} placement="topbar" controlsId="avisos" />);
    expect(html).toContain('Sin avisos nuevos');
    expect(html).not.toContain('bell-badge');
  });
});
