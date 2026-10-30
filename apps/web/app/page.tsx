'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import Sidebar from '../components/Sidebar';
import { api } from '../lib/api';
import AdminDayView from '../components/AdminDayView';
import Icon, { EmptyState } from '../components/Icon';
import { invalidateViewer, modalityLabel, useViewer, Viewer } from '../lib/clinical';
import { appHref, patientHref, patientTasksToReviewHref, sessionHref, taskReviewPatientId, tasksToReviewHref } from '@/lib/routes';

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
    clinicalProcess?: { modality: string } | null;
  };
  sessions: Array<{
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    type: string;
    patient: { id: string; firstName: string; lastName: string };
    clinicalProcess?: { modality: string } | null;
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

/** Saludo con el nombre de GET /auth/me; sin nombre, sin coma colgando. */
function greetingFor(firstName?: string | null) {
  const name = firstName?.trim();
  return name ? `Buenos días, ${name}` : 'Buenos días';
}

function minutesUntil(value: string) {
  return Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 60000));
}

/**
 * "Mi jornada". Quien atiende pacientes ve la jornada clínica (GET /dashboard). La recepción
 * (ASSISTANT) y titular/administración sin "atiende pacientes" ven la jornada administrativa, que
 * no llama a /dashboard ni muestra nada clínico.
 */
export default function Home() {
  const viewer = useViewer();

  if (!viewer) {
    return <div className="app-layout"><Sidebar /><main className="dashboard"><section className="dashboard-card dashboard-loading" role="status">Preparando tu jornada…</section></main></div>;
  }

  if (viewer.mfaPending) {
    return (
      <div className="app-layout"><Sidebar /><main className="dashboard"><section className="dashboard-card dashboard-error" role="alert">
        <h1>Activa la verificación en dos pasos</h1>
        <p>Para seguir usando AsePsico tienes que activarla. Necesitarás una app de autenticación en tu móvil.</p>
        <Link href="/settings/security" className="primary-action">Activarla ahora</Link>
      </section></main></div>
    );
  }

  if (!viewer.role) {
    // No se ha podido saber quién eres (fallo de red o de la API): no se adivina la vista.
    return (
      <div className="app-layout"><Sidebar /><main className="dashboard"><section className="dashboard-card dashboard-error" role="alert">
        <h1>No hemos podido preparar tu jornada</h1>
        <p>Comprueba tu conexión y vuelve a intentarlo.</p>
        <button className="primary-action" onClick={() => { invalidateViewer(); window.location.reload(); }}>Reintentar</button>
      </section></main></div>
    );
  }

  if (!viewer.isClinician) {
    return <div className="app-layout"><Sidebar syncText="Información actualizada" /><AdminDayView viewer={viewer} /></div>;
  }

  return <ClinicalHome viewer={viewer} />;
}

function ClinicalHome({ viewer }: { viewer: Viewer }) {
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
  // «Tareas por revisar» lleva a las tareas entregadas con el filtro «Por revisar».
  const reviewPatientIds = data.attention.filter((item) => item.type === 'TASK_REVIEW').map((item) => taskReviewPatientId(item.href));
  const attentionHref = (item: DashboardData['attention'][number]) => {
    const reviewPatientId = item.type === 'TASK_REVIEW' ? taskReviewPatientId(item.href) : '';
    return reviewPatientId ? patientTasksToReviewHref(reviewPatientId) : appHref(item.href);
  };

  return (
    <div className="app-layout">
      <Sidebar syncText="Información actualizada" />
      <main className="dashboard">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">MI JORNADA</p>
            <h1>{greetingFor(viewer.firstName || data.professional.firstName)}</h1>
            <p className="dashboard-subtitle">
              {data.summary.sessionsToday === 0
                ? 'No tienes sesiones programadas para hoy.'
                : `Hoy tienes ${data.summary.sessionsToday} ${data.summary.sessionsToday === 1 ? 'sesión' : 'sesiones'}.`}
              {' '}{data.attention.length} {data.attention.length === 1 ? 'asunto requiere' : 'asuntos requieren'} tu atención.
            </p>
          </div>
          <div className="dashboard-actions">
            <Link href="/agenda?new=true" className="search-action"><Icon name="calendar" size={18} />Nueva cita</Link>
            <Link href="/patients?new=true" className="primary-action"><Icon name="plus" size={18} />Nuevo paciente</Link>
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
                <Link key={item.key} href={appHref(item.href)} className={item.done ? 'done' : ''}>
                  <span className="onboarding-check">{item.done ? <Icon name="check" size={14} /> : null}</span><strong>{item.label}</strong><Icon name="chevronRight" size={16} />
                </Link>
              ))}
              <button type="button" onClick={() => void dismissOnboarding()}>Ocultar por ahora</button>
            </div>
          </section>
        )}

        {next ? (
          <section className="next-session">
            <div>
              <span className="next-session-label"><Icon name="clock" size={14} />Próxima sesión · en {minutesUntil(next.startsAt)} min</span>
              <h2>{next.patient.firstName} {next.patient.lastName}</h2>
              <p>{formatTime(next.startsAt)} · {next.clinicalProcess ? `Proceso clínico · ${modalityLabel(next.clinicalProcess.modality) ?? 'Modalidad no definida'}` : 'Sin proceso asociado'}</p>
            </div>
            <div className="next-session-actions">
              <Link href={patientHref(next.patient.id)} className="banner-secondary">Abrir ficha</Link>
              <Link href={sessionHref(next.id)} className="banner-primary">Preparar sesión<Icon name="arrowRight" size={16} /></Link>
            </div>
          </section>
        ) : (
          <section className="dashboard-card empty-next-session">
            <span className="empty-next-icon"><Icon name="sun" size={26} /></span>
            <div><p className="eyebrow">AGENDA</p><h2>Tu jornada está despejada</h2><p>Programa una cita o aprovecha para revisar seguimientos pendientes.</p></div>
            <Link href="/agenda?new=true" className="primary-action"><Icon name="plus" size={18} />Programar cita</Link>
          </section>
        )}

        <section className="dashboard-metrics" aria-label="Resumen de jornada">
          <Link href="/agenda" className="dashboard-card metric-card metric-violet"><span><Icon name="calendar" /></span><div><strong>{data.summary.sessionsToday}</strong><small>Sesiones hoy</small></div></Link>
          <Link href={tasksToReviewHref(reviewPatientIds)} className="dashboard-card metric-card metric-green"><span><Icon name="clipboard" /></span><div><strong>{data.summary.pendingReviews}</strong><small>Tareas por revisar</small></div></Link>
          <Link href="/messages" className="dashboard-card metric-card metric-blue"><span><Icon name="message" /></span><div><strong>{data.summary.unreadMessages}</strong><small>Mensajes nuevos</small></div></Link>
          <Link href="/follow-up" className="dashboard-card metric-card metric-amber"><span><Icon name="trend" /></span><div><strong>{data.summary.followUps}</strong><small>Seguimientos</small></div></Link>
        </section>

        <div className="dashboard-grid">
          <section className="dashboard-card sessions-card">
            <div className="card-heading"><div><p className="eyebrow">HOY</p><h2>Sesiones</h2></div><Link href="/agenda" className="text-link">Ver agenda completa</Link></div>
            <div className="sessions-list">
              {data.sessions.length ? data.sessions.map((session) => (
                <article key={session.id} className="session-row">
                  <div className="session-time"><strong>{formatTime(session.startsAt)}</strong><span>{Math.round((new Date(session.endsAt).getTime() - new Date(session.startsAt).getTime()) / 60000)} min</span></div>
                  <div className="session-avatar purple">{session.patient.firstName[0]}{session.patient.lastName[0]}</div>
                  <div className="session-copy"><div className="session-name"><strong>{session.patient.firstName} {session.patient.lastName}</strong><span>{session.type}</span></div><p>{session.clinicalProcess ? `Proceso clínico · ${modalityLabel(session.clinicalProcess.modality) ?? 'Modalidad no definida'}` : 'Sin proceso asociado'}</p><small className={`session-status ui-chip ${session.status === 'SCHEDULED' ? 'chip-violet' : 'chip-neutral'}`}>{session.status === 'SCHEDULED' ? 'Programada' : session.status}</small></div>
                  <div className="session-buttons"><Link href={patientHref(session.patient.id)} className="small-secondary">Abrir caso</Link><Link href={sessionHref(session.id)} className="small-primary">Preparar</Link></div>
                </article>
              )) : <EmptyState icon="calendar" title="No hay sesiones hoy">La agenda de hoy está libre. Buen momento para revisar seguimientos.</EmptyState>}
            </div>
          </section>

          <aside className="dashboard-side">
            <section className="dashboard-card attention-card">
              <div className="card-heading"><div><p className="eyebrow">REQUIERE ATENCIÓN</p><h2>Próximas acciones</h2></div><span className="task-count">{data.attention.length}</span></div>
              <div className="task-list">
                {data.attention.length ? data.attention.map((item) => (
                  <Link key={item.id} href={attentionHref(item)} className="task-row"><span className={`task-checkbox task-${item.type === 'MESSAGE' ? 'message' : item.type === 'TASK_REVIEW' ? 'review' : 'follow'}`}><Icon name={item.type === 'MESSAGE' ? 'message' : item.type === 'TASK_REVIEW' ? 'clipboard' : 'trend'} size={16} /></span><span><strong>{item.title}</strong><small>{item.subtitle}</small></span><Icon name="chevronRight" size={16} /></Link>
                )) : <EmptyState icon="checkCircle" title="Todo al día" compact>No hay acciones pendientes.</EmptyState>}
              </div>
            </section>
            <section className="dashboard-card quick-card"><p className="eyebrow">ACCESO RÁPIDO</p><div className="quick-grid"><Link href="/agenda?new=true"><span><Icon name="calendar" size={18} /></span>Nueva cita</Link><Link href="/patients?new=true"><span><Icon name="users" size={18} /></span>Nuevo paciente</Link><Link href="/messages"><span><Icon name="message" size={18} /></span>Mensajes</Link><Link href="/management"><span><Icon name="wallet" size={18} /></span>Registrar cobro</Link></div></section>
          </aside>
        </div>
      </main>
    </div>
  );
}
