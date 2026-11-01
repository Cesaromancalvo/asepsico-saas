'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import Icon, { EmptyState } from './Icon';
import {
  CHANGE_LABEL,
  changeTone,
  listStaffNotifications,
  markNotificationRead,
  noticeTarget,
  openNotice,
  relativeTime,
  STAFF_NOTIFICATIONS_EVENT,
  StaffNotification,
} from '../lib/staff-notifications';

/*
 * «Cambios de agenda» en Mi jornada: avisos de cambio de cita sin leer (GET /notifications?unreadOnly=true,
 * solo los que traen appointmentChange). Sirve igual para la jornada clínica y para la de recepción:
 * el texto lo compone la API con el acceso de agenda de quien lo lee (solo nombre, fecha y hora).
 * Se recarga cuando la campana u otra pantalla marca avisos como leídos.
 */

const VISIBLE = 5;
type State = { state: 'loading' | 'ready' | 'error'; items: StaffNotification[] };

export default function AppointmentChangesCard({ reception = false }: { reception?: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<State>({ state: 'loading', items: [] });
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    try {
      const items = await listStaffNotifications(true);
      setData({ state: 'ready', items: items.filter((n) => n.appointmentChange) });
    } catch {
      setData((current) => ({ state: current.items.length ? 'ready' : 'error', items: current.items }));
    }
  }, []);

  useEffect(() => {
    void load();
    const reload = () => { void load(); };
    window.addEventListener(STAFF_NOTIFICATIONS_EVENT, reload);
    return () => window.removeEventListener(STAFF_NOTIFICATIONS_EVENT, reload);
  }, [load]);

  async function markRead(n: StaffNotification) {
    setActionError('');
    try {
      await markNotificationRead(n.id); // avisa a la campana y recarga este bloque
    } catch {
      setActionError('No se ha podido marcar como leído. Inténtalo de nuevo.');
    }
  }

  const visible = data.items.slice(0, VISIBLE);
  const more = data.items.length - visible.length;

  return (
    <section className="dashboard-card attention-card agenda-changes-card" aria-labelledby="agenda-changes-title">
      <div className="card-heading">
        <div><p className="eyebrow">AVISOS</p><h2 id="agenda-changes-title">Cambios de agenda</h2></div>
        {data.state === 'ready' && <span className="task-count" aria-label={`${data.items.length} sin leer`}>{data.items.length}</span>}
      </div>
      {actionError && <p className="bell-error" role="alert">{actionError}</p>}
      <div className="task-list">
        {data.state === 'loading' && <p className="muted" role="status">Cargando…</p>}
        {data.state === 'error' && (
          <div className="dashboard-empty compact" role="alert">
            <strong>No se han podido cargar los cambios de agenda</strong>
            <p>Comprueba tu conexión y vuelve a intentarlo.</p>
            <button type="button" className="small-secondary" onClick={() => { setData({ state: 'loading', items: [] }); void load(); }}>Reintentar</button>
          </div>
        )}
        {data.state === 'ready' && data.items.length === 0 && (
          <EmptyState icon="checkCircle" title="Sin cambios pendientes" compact>
            {reception
              ? 'Cuando un paciente pida cambiar o cancelar una cita, lo verás aquí.'
              : 'Si alguien mueve o cancela una cita tuya, o un paciente pide cambiarla, lo verás aquí.'}
          </EmptyState>
        )}
        {visible.map((n) => {
          const change = n.appointmentChange!;
          const target = noticeTarget(n);
          return (
            <article key={n.id} className="agenda-change-row">
              <span className={`ui-chip ${changeTone(change.change)}`}>{CHANGE_LABEL[change.change]}</span>
              <p>{n.body}</p>
              <small>{relativeTime(n.createdAt)}</small>
              <div className="agenda-change-actions">
                {target && (
                  <button type="button" className="small-primary" onClick={() => void openNotice(n, (href) => router.push(href))}>
                    {target.label}<Icon name="arrowRight" size={14} />
                  </button>
                )}
                <button type="button" className="small-secondary" onClick={() => void markRead(n)}>Marcar como leído</button>
              </div>
            </article>
          );
        })}
        {more > 0 && (
          <Link href="/notifications" className="text-link agenda-changes-more">Ver los {data.items.length} cambios en Avisos</Link>
        )}
      </div>
    </section>
  );
}
