'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import Sidebar from '../components/Sidebar';
import { api } from '../lib/api';

type DashboardData = {
  professional: { firstName: string; lastName: string; role: string };
  summary: { sessionsToday: number; pendingReviews: number; unreadMessages: number; followUps: number };
  nextSession: null | {
    id: string;
    startsAt: string;
    endsAt: string;
    type: string;
    location?: string | null;
    patient: { id: string; firstName: string; lastName: string };
    clinicalProcess?: { title: string; modality: string } | null;
  };
  sessions: Array<{
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    type: string;
    patient: { id: string; firstName: string; lastName: string };
    clinicalProcess?: { title: string; modality: string } | null;
  }>;
  attention: Array<{ id: string; type: string; title: string; subtitle: string; href: string }>;
  onboarding: {
    step: number;
    completed: boolean;
    dismissed: boolean;
    checklist: Array<{ key: string; label: string; done: boolean; href: string }>;
  };
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function minutesUntil(value: string) {
  return Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 60000));
}

export default function Home() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setLoading(true);
      setData(await api<DashboardData>('/dashboard'));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la jornada');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const completedOnboarding = useMemo(
    () => data?.onboarding.checklist.filter((item) => item.done).length ?? 0,
    [data],
  );

  async function dismissOnboarding() {
    await api('/dashboard/onboarding', { method: 'PATCH', body: JSON.stringify({ dismissed: true }) });
    setData((current) => current ? { ...current, onboarding: { ...current.onboarding, dismissed: true } } : current);
  }

  if (loading) {
    return <div className="app-layout"><Sidebar /><main className="dashboard"><section className="dashboard-card dashboard-loading">Preparando tu jornada…</section></main></div>;
  }

  if (!data || error) {
    return <div className="app-layout"><Sidebar /><main className="dashboard"><section className="dashboard-card dashboard-error"><h1>No hemos podido preparar tu jornada</h1><p>{error}</p><button className="primary-action" onClick={() => void load()}>Reintentar</button></section></main></div>;
  }

  const next = data.nextSession;

  return (
    <div className="app-layout">
      <Sidebar syncText="Información actualizada" />
      <main className="dashboard">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">MI JORNADA</p>
            <h1>Buenos días, {data.professional.firstName}</h1>
            <p className="dashboard-subtitle">
              {data.summary.sessionsToday === 0
                ? 'No tienes sesiones programadas para hoy.'
                : `Hoy tienes ${data.summary.sessionsToday} ${data.summary.sessionsToday === 1 ? 'sesión' : 'sesiones'}.`}
              {' '}{data.attention.length} {data.attention.length === 1 ? 'asunto requiere' : 'asuntos requieren'} tu atención.
            </p>
          </div>
          <div className="dashboard-actions">
            <Link href="/patients?new=true" className="primary-action">+ Nuevo paciente</Link>
            <Link href="/agenda?new=true" className="search-action">+ Nueva cita</Link>
          </div>
        </header>

        {!data.onboarding.completed && !data.onboarding.dismissed && (
          <section className="dashboard-card onboarding-card">
            <div className="onboarding-copy">
              <p className="eyebrow">PRIMEROS PASOS</p>
              <h2>Deja AsePsico listo para tu consulta</h2>
              <p>Completa estas acciones básicas. Puedes seguir trabajando mientras avanzas.</p>
              <div className="onboarding-progress"><span style={{ width: `${(completedOnboarding / data.onboarding.checklist.length) * 100}%` }} /></div>
              <small>{completedOnboarding} de {data.onboarding.checklist.length} completados</small>
            </div>
            <div className="onboarding-list">
              {data.onboarding.checklist.map((item) => (
                <Link key={item.key} href={item.href} className={item.done ? 'done' : ''}>
                  <span>{item.done ? '✓' : '○'}</span><strong>{item.label}</strong><span>›</span>
                </Link>
              ))}
              <button type="button" onClick={() => void dismissOnboarding()}>Ocultar por ahora</button>
            </div>
          </section>
        )}

        {next ? (
          <section className="next-session">
            <div>
              <span className="next-session-label">PRÓXIMA SESIÓN · EN {minutesUntil(next.startsAt)} MIN</span>
              <h2>{next.patient.firstName} {next.patient.lastName}</h2>
              <p>{formatTime(next.startsAt)} · {next.clinicalProcess?.title ?? 'Proceso clínico'} · {next.clinicalProcess?.modality === 'ONLINE' ? 'Online' : 'Presencial'}</p>
            </div>
            <div className="next-session-actions">
              <Link href={`/patients/${next.patient.id}`} className="banner-secondary">Abrir ficha</Link>
              <Link href={`/agenda/${next.id}`} className="banner-primary">Preparar sesión →</Link>
            </div>
          </section>
        ) : (
          <section className="dashboard-card empty-next-session">
            <div><p className="eyebrow">AGENDA</p><h2>Tu jornada está despejada</h2><p>Programa una cita o aprovecha para revisar seguimientos pendientes.</p></div>
            <Link href="/agenda?new=true" className="primary-action">Programar cita</Link>
          </section>
        )}

        <section className="dashboard-metrics" aria-label="Resumen de jornada">
          <Link href="/agenda" className="dashboard-card metric-card"><span>▣</span><div><strong>{data.summary.sessionsToday}</strong><small>Sesiones hoy</small></div></Link>
          <Link href="/follow-up" className="dashboard-card metric-card"><span>✓</span><div><strong>{data.summary.pendingReviews}</strong><small>Tareas por revisar</small></div></Link>
          <Link href="/messages" className="dashboard-card metric-card"><span>✉</span><div><strong>{data.summary.unreadMessages}</strong><small>Mensajes nuevos</small></div></Link>
          <Link href="/follow-up" className="dashboard-card metric-card"><span>↗</span><div><strong>{data.summary.followUps}</strong><small>Seguimientos</small></div></Link>
        </section>

        <div className="dashboard-grid">
          <section className="dashboard-card sessions-card">
            <div className="card-heading"><div><p className="eyebrow">HOY</p><h2>Sesiones</h2></div><Link href="/agenda" className="text-link">Ver agenda completa</Link></div>
            <div className="sessions-list">
              {data.sessions.length ? data.sessions.map((session) => (
                <article key={session.id} className="session-row">
                  <div className="session-time"><strong>{formatTime(session.startsAt)}</strong><span>{Math.round((new Date(session.endsAt).getTime() - new Date(session.startsAt).getTime()) / 60000)} min</span></div>
                  <div className="session-avatar purple">{session.patient.firstName[0]}{session.patient.lastName[0]}</div>
                  <div className="session-copy"><div className="session-name"><strong>{session.patient.firstName} {session.patient.lastName}</strong><span>{session.type}</span></div><p>{session.clinicalProcess?.title ?? 'Proceso clínico'}</p><small className="session-status purple">{session.status === 'SCHEDULED' ? 'Programada' : session.status}</small></div>
                  <div className="session-buttons"><Link href={`/patients/${session.patient.id}`} className="small-secondary">Abrir caso</Link><Link href={`/agenda/${session.id}`} className="small-primary">Preparar</Link></div>
                </article>
              )) : <div className="dashboard-empty"><strong>No hay sesiones hoy</strong><p>La agenda de hoy está libre.</p></div>}
            </div>
          </section>

          <aside className="dashboard-side">
            <section className="dashboard-card attention-card">
              <div className="card-heading"><div><p className="eyebrow">REQUIERE ATENCIÓN</p><h2>Próximas acciones</h2></div><span className="task-count">{data.attention.length}</span></div>
              <div className="task-list">
                {data.attention.length ? data.attention.map((item) => (
                  <Link key={item.id} href={item.href} className="task-row"><span className="task-checkbox">{item.type === 'MESSAGE' ? '✉' : item.type === 'TASK_REVIEW' ? '✓' : '↗'}</span><span><strong>{item.title}</strong><small>{item.subtitle}</small></span><span>›</span></Link>
                )) : <div className="dashboard-empty compact"><strong>Todo al día</strong><p>No hay acciones pendientes.</p></div>}
              </div>
            </section>
            <section className="dashboard-card quick-card"><p className="eyebrow">ACCESO RÁPIDO</p><div className="quick-grid"><Link href="/agenda?new=true"><span>＋</span>Nueva cita</Link><Link href="/patients?new=true"><span>◉</span>Nuevo paciente</Link><Link href="/messages"><span>✉</span>Mensajes</Link><Link href="/management"><span>€</span>Crear factura</Link></div></section>
          </aside>
        </div>
      </main>
    </div>
  );
}
