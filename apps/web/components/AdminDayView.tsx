'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ROLE_LABEL, Viewer } from '@/lib/clinical';

/*
 * "Mi jornada" administrativa: recepción (ASSISTANT) y titular/administración que no atienden
 * pacientes. No llama a GET /dashboard (es la vista clínica: a un ASSISTANT le responde 403).
 * Solo usa endpoints administrativos que ya existen:
 *  - GET /sessions?from&to → citas de hoy de todo el equipo (metadatos, sin notas). Del proceso
 *    clínico que trae cada fila no se muestra nada.
 *  - GET /billing/summary y GET /billing/invoices → pendientes de cobro.
 *  - GET /notifications?unreadOnly=true → avisos propios; se omiten los de tareas terapéuticas y
 *    solo se enseña el título.
 * Cada bloque carga por separado: si uno falla, el resto se sigue viendo.
 */

type Person = { id: string; firstName: string; lastName: string };
type SessionRow = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  type: string;
  patient: Person;
  therapist?: Person | null;
};
type Invoice = { id: string; invoiceNumber: string; status: string; totalCents: number; paidCents: number; dueDate?: string | null; patient: Person };
type BillingSummary = { outstandingCents: number; overdueCount: number };
type Notice = { id: string; type: string; title: string; createdAt: string };
type Block<T> = { state: 'loading' | 'ready' | 'error' | 'forbidden'; data: T | null };

const STATUS_LABEL: Record<SessionRow['status'], string> = {
  SCHEDULED: 'Programada',
  COMPLETED: 'Completada',
  CANCELLED: 'Cancelada',
  NO_SHOW: 'No asistió',
};
const TYPE_LABEL: Record<string, string> = {
  INDIVIDUAL: 'Individual',
  COUPLE: 'Pareja',
  FAMILY: 'Familiar',
  GROUP: 'Grupal',
  FOLLOW_UP: 'Seguimiento',
  ASSESSMENT: 'Evaluación',
};
const OPEN_INVOICE = new Set(['ISSUED', 'PARTIALLY_PAID', 'OVERDUE']);
// Avisos que no son administrativos (tareas terapéuticas): no se enseñan aquí.
const NON_ADMIN_NOTICES = new Set(['TASK_DUE']);

const money = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const time = (value: string) => new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const shortDate = (value: string) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date(value));
const fullName = (p?: Person | null) => (p ? `${p.firstName} ${p.lastName}`.trim() : '');
const initials = (p: Person) => `${p.firstName?.[0] ?? ''}${p.lastName?.[0] ?? ''}`.toUpperCase();

function settle<T>(promise: Promise<T>): Promise<Block<T>> {
  return promise
    .then((data) => ({ state: 'ready' as const, data }))
    .catch((err: unknown) => ({ state: (err as { status?: number })?.status === 403 ? ('forbidden' as const) : ('error' as const), data: null }));
}

export default function AdminDayView({ viewer }: { viewer: Viewer }) {
  const [sessions, setSessions] = useState<Block<SessionRow[]>>({ state: 'loading', data: null });
  const [summary, setSummary] = useState<Block<BillingSummary>>({ state: 'loading', data: null });
  const [invoices, setInvoices] = useState<Block<Invoice[]>>({ state: 'loading', data: null });
  const [notices, setNotices] = useState<Block<Notice[]>>({ state: 'loading', data: null });

  const load = useCallback(async () => {
    setSessions({ state: 'loading', data: null });
    setSummary({ state: 'loading', data: null });
    setInvoices({ state: 'loading', data: null });
    setNotices({ state: 'loading', data: null });
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const [s, b, i, n] = await Promise.all([
      settle(api<{ data: SessionRow[] }>(`/sessions?from=${start.toISOString()}&to=${end.toISOString()}&pageSize=100`).then((r) => r.data)),
      settle(api<BillingSummary>('/billing/summary')),
      settle(api<Invoice[]>('/billing/invoices')),
      settle(api<Notice[]>('/notifications?unreadOnly=true')),
    ]);
    setSessions(s);
    setSummary(b);
    setInvoices(i);
    setNotices(n);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const today = sessions.data ?? [];
  const active = today.filter((x) => x.status !== 'CANCELLED');
  const pendingInvoices = (invoices.data ?? [])
    .filter((x) => OPEN_INVOICE.has(x.status) && x.totalCents > x.paidCents)
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'))
    .slice(0, 5);
  const adminNotices = (notices.data ?? []).filter((x) => !NON_ADMIN_NOTICES.has(x.type)).slice(0, 5);
  const billingHidden = summary.state === 'forbidden' && invoices.state === 'forbidden';
  const greeting = viewer.firstName ? `Buenos días, ${viewer.firstName}` : 'Buenos días';
  const roleLabel = viewer.role ? ROLE_LABEL[viewer.role] : null;

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">MI JORNADA{roleLabel ? ` · ${roleLabel.toUpperCase()}` : ''}</p>
          <h1>{greeting}</h1>
          <p className="dashboard-subtitle">
            {sessions.state === 'loading' && 'Cargando la agenda de hoy…'}
            {sessions.state === 'ready' &&
              (active.length === 0
                ? 'Hoy no hay citas programadas en la consulta.'
                : `Hoy hay ${active.length} ${active.length === 1 ? 'cita' : 'citas'} en la consulta.`)}
            {(sessions.state === 'error' || sessions.state === 'forbidden') && 'Vista administrativa de la consulta.'}
          </p>
        </div>
        <div className="dashboard-actions">
          <Link href="/agenda?new=true" className="primary-action">+ Nueva cita</Link>
          <Link href="/patients?new=true" className="search-action">+ Nuevo paciente</Link>
        </div>
      </header>

      <section className="dashboard-metrics" aria-label="Resumen administrativo de hoy">
        <Link href="/agenda" className="dashboard-card metric-card">
          <span aria-hidden="true">▣</span>
          <div><strong>{sessions.state === 'ready' ? active.length : '–'}</strong><small>Citas hoy</small></div>
        </Link>
        {!billingHidden && (
          <>
            <Link href="/management" className="dashboard-card metric-card">
              <span aria-hidden="true">€</span>
              <div><strong>{summary.data ? money(summary.data.outstandingCents) : '–'}</strong><small>Pendiente de cobro</small></div>
            </Link>
            <Link href="/management" className="dashboard-card metric-card">
              <span aria-hidden="true">!</span>
              <div><strong>{summary.data ? summary.data.overdueCount : '–'}</strong><small>Cobros vencidos</small></div>
            </Link>
          </>
        )}
        <Link href="/notifications" className="dashboard-card metric-card">
          <span aria-hidden="true">◌</span>
          <div><strong>{notices.state === 'ready' ? adminNotices.length : '–'}</strong><small>Avisos sin leer</small></div>
        </Link>
      </section>

      <div className="dashboard-grid">
        <section className="dashboard-card sessions-card" aria-labelledby="admin-today-title">
          <div className="card-heading">
            <div><p className="eyebrow">HOY · TODO EL EQUIPO</p><h2 id="admin-today-title">Citas</h2></div>
            <Link href="/agenda" className="text-link">Ver agenda completa</Link>
          </div>
          <div className="sessions-list">
            {sessions.state === 'loading' && <p className="muted" role="status">Cargando las citas de hoy…</p>}
            {(sessions.state === 'error' || sessions.state === 'forbidden') && (
              <div className="dashboard-empty" role="alert">
                <strong>No se han podido cargar las citas</strong>
                <p>Comprueba tu conexión y vuelve a intentarlo.</p>
                <button type="button" className="button secondary" onClick={() => void load()}>Reintentar</button>
              </div>
            )}
            {sessions.state === 'ready' && today.length === 0 && (
              <div className="dashboard-empty"><strong>No hay citas hoy</strong><p>La agenda de la consulta está libre.</p></div>
            )}
            {sessions.state === 'ready' && today.map((session) => (
              <article key={session.id} className="session-row admin-session-row">
                <div className="session-time">
                  <strong>{time(session.startsAt)}</strong>
                  <span>{Math.round((new Date(session.endsAt).getTime() - new Date(session.startsAt).getTime()) / 60000)} min</span>
                </div>
                <div className="session-avatar purple" aria-hidden="true">{initials(session.patient)}</div>
                <div className="session-copy">
                  <div className="session-name">
                    <strong>{fullName(session.patient)}</strong>
                    <span>{TYPE_LABEL[session.type] ?? 'Cita'}</span>
                  </div>
                  <p>{session.therapist ? `Con ${fullName(session.therapist)}` : 'Profesional sin asignar'}</p>
                  <small className="session-status purple">{STATUS_LABEL[session.status] ?? session.status}</small>
                </div>
                <div className="session-buttons">
                  <Link href={`/agenda/${session.id}`} className="small-primary">
                    Ver cita<span className="sr-only"> de {fullName(session.patient)} a las {time(session.startsAt)}</span>
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="dashboard-side">
          {!billingHidden && (
            <section className="dashboard-card attention-card" aria-labelledby="admin-billing-title">
              <div className="card-heading">
                <div><p className="eyebrow">COBROS</p><h2 id="admin-billing-title">Pendientes de cobro</h2></div>
                {invoices.state === 'ready' && <span className="task-count">{pendingInvoices.length}</span>}
              </div>
              <div className="task-list">
                {invoices.state === 'loading' && <p className="muted" role="status">Cargando…</p>}
                {(invoices.state === 'error' || invoices.state === 'forbidden') && (
                  <div className="dashboard-empty compact" role="alert"><strong>No se han podido cargar los cobros</strong><p>Inténtalo de nuevo en unos minutos.</p></div>
                )}
                {invoices.state === 'ready' && pendingInvoices.length === 0 && (
                  <div className="dashboard-empty compact"><strong>Todo cobrado</strong><p>No hay cobros pendientes.</p></div>
                )}
                {pendingInvoices.map((invoice) => (
                  <Link key={invoice.id} href="/management" className="task-row">
                    <span className="task-checkbox" aria-hidden="true">€</span>
                    <span>
                      <strong>{fullName(invoice.patient)} · {money(invoice.totalCents - invoice.paidCents)}</strong>
                      <small>
                        {invoice.invoiceNumber}
                        {invoice.dueDate ? ` · vence el ${shortDate(invoice.dueDate)}` : ''}
                        {invoice.status === 'OVERDUE' ? ' · vencida' : ''}
                      </small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="dashboard-card attention-card" aria-labelledby="admin-notices-title">
            <div className="card-heading">
              <div><p className="eyebrow">AVISOS</p><h2 id="admin-notices-title">Avisos administrativos</h2></div>
              {notices.state === 'ready' && <span className="task-count">{adminNotices.length}</span>}
            </div>
            <div className="task-list">
              {notices.state === 'loading' && <p className="muted" role="status">Cargando…</p>}
              {(notices.state === 'error' || notices.state === 'forbidden') && (
                <div className="dashboard-empty compact" role="alert"><strong>No se han podido cargar los avisos</strong><p>Inténtalo de nuevo en unos minutos.</p></div>
              )}
              {notices.state === 'ready' && adminNotices.length === 0 && (
                <div className="dashboard-empty compact"><strong>Todo al día</strong><p>No tienes avisos sin leer.</p></div>
              )}
              {adminNotices.map((notice) => (
                <Link key={notice.id} href="/notifications" className="task-row">
                  <span className="task-checkbox" aria-hidden="true">◌</span>
                  <span><strong>{notice.title}</strong><small>{shortDate(notice.createdAt)}</small></span>
                  <span aria-hidden="true">›</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="dashboard-card quick-card">
            <p className="eyebrow">ACCESO RÁPIDO</p>
            <div className="quick-grid">
              <Link href="/agenda?new=true"><span aria-hidden="true">＋</span>Nueva cita</Link>
              <Link href="/patients?new=true"><span aria-hidden="true">◉</span>Nuevo paciente</Link>
              <Link href="/agenda"><span aria-hidden="true">▣</span>Agenda</Link>
              {!billingHidden && <Link href="/management"><span aria-hidden="true">€</span>Registrar cobro</Link>}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
