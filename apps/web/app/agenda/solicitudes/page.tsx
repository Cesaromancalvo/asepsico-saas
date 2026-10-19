'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { RejectionReason, StaffAppointmentRequestContract } from '@asepsico/contracts';
import Sidebar from '@/components/Sidebar';
import RequestCard from '@/components/RequestCard';
import RejectRequestDialog from '@/components/RejectRequestDialog';
import Icon, { EmptyState } from '@/components/Icon';
import { ApiError } from '@/lib/api';
import { approveRequest, listRequests, notifyPendingChanged, rejectRequest } from '@/lib/booking-client';
import { isForbidden, useViewer } from '@/lib/clinical';

type Tab = 'PENDING' | 'HISTORY';
type State = 'loading' | 'ready' | 'error' | 'forbidden';

const APPROVED_MESSAGE = {
  NEW: 'Cita aceptada. Ya está en la agenda.',
  RESCHEDULE: 'Cambio aceptado. La cita está en su nueva hora.',
  CANCEL: 'Cancelación aceptada. La cita se ha cancelado.',
} as const;

/**
 * Bandeja de solicitudes de cita del portal. Cada profesional ve las suyas; recepción, titular y
 * administración ven las de toda la consulta. Aceptar crea, mueve o cancela la cita; rechazar pide
 * un motivo de una lista cerrada. El contador de la barra lateral se refresca al resolver.
 */
export default function RequestsPage() {
  const viewer = useViewer();
  const [tab, setTab] = useState<Tab>('PENDING');
  const [items, setItems] = useState<StaffAppointmentRequestContract[]>([]);
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<StaffAppointmentRequestContract | null>(null);

  const load = useCallback(async (which: Tab) => {
    setState('loading');
    setError('');
    try {
      const rows = await listRequests(which === 'PENDING' ? 'PENDING' : undefined);
      setItems(which === 'PENDING' ? rows.filter((r) => r.status === 'PENDING') : rows.filter((r) => r.status !== 'PENDING'));
      setState('ready');
    } catch (err) {
      if (isForbidden(err)) { setState('forbidden'); return; }
      setError(err instanceof Error && err.message ? err.message : 'No se pudieron cargar las solicitudes.');
      setState('error');
    }
  }, []);

  useEffect(() => { void load(tab); }, [tab, load]);

  async function approve(request: StaffAppointmentRequestContract) {
    setBusy(true); setError(''); setStatus('');
    try {
      await approveRequest(request.id);
      setStatus(APPROVED_MESSAGE[request.type]);
    } catch (err) {
      // 409: el hueco ya no está libre, el proceso se cerró o ya se resolvió. La API explica el motivo.
      setError(err instanceof ApiError && err.message ? err.message : 'No se pudo aceptar la solicitud.');
    } finally {
      setBusy(false);
      notifyPendingChanged();
      await load(tab);
    }
  }

  async function reject(reason: RejectionReason): Promise<string | null> {
    if (!rejecting) return 'No se encontró la solicitud.';
    try {
      await rejectRequest(rejecting.id, reason);
      setStatus('Solicitud rechazada. El paciente verá el motivo en su portal.');
      setError('');
      notifyPendingChanged();
      await load(tab);
      return null;
    } catch (err) {
      return err instanceof Error && err.message ? err.message : 'No se pudo rechazar la solicitud.';
    }
  }

  const showTherapist = viewer?.role !== 'THERAPIST';

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="dashboard">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">AGENDA</p>
            <h1>Solicitudes de cita</h1>
            <p className="dashboard-subtitle">Lo que tus pacientes piden desde su portal. La cita no queda reservada hasta que la aceptes.</p>
          </div>
          <div className="dashboard-actions">
            <Link href="/agenda" className="agenda-navigation-button"><Icon name="arrowLeft" size={18} />Agenda</Link>
            <Link href="/agenda/disponibilidad" className="primary-action"><Icon name="clock" size={18} />Mi disponibilidad</Link>
          </div>
        </header>

        <div className="bk-tabs" role="group" aria-label="Qué solicitudes ver">
          <button type="button" className={`bk-tab${tab === 'PENDING' ? ' is-active' : ''}`} aria-pressed={tab === 'PENDING'} onClick={() => setTab('PENDING')}>Pendientes</button>
          <button type="button" className={`bk-tab${tab === 'HISTORY' ? ' is-active' : ''}`} aria-pressed={tab === 'HISTORY'} onClick={() => setTab('HISTORY')}>Respondidas</button>
        </div>

        <p className={status ? 'patient-save-state' : 'bk-live'} role="status" aria-live="polite">{status}</p>
        {error && state !== 'error' && <div className="agenda-error" role="alert">{error}</div>}

        {state === 'loading' && <section className="dashboard-card dashboard-loading" role="status">Cargando solicitudes…</section>}

        {state === 'forbidden' && (
          <section className="dashboard-card">
            <EmptyState icon="lock" title="Sin acceso a esta sección">Las solicitudes de cita están disponibles para el equipo de la consulta.</EmptyState>
          </section>
        )}

        {state === 'error' && (
          <section className="dashboard-card dashboard-error" role="alert">
            <p>{error}</p>
            <button type="button" className="button secondary" onClick={() => void load(tab)}>Intentar de nuevo</button>
          </section>
        )}

        {state === 'ready' && items.length === 0 && (
          <section className="dashboard-card">
            {tab === 'PENDING' ? (
              <EmptyState icon="inbox" title="No tienes solicitudes pendientes">
                Cuando un paciente pida una cita desde su portal, la verás aquí. Si todavía no lo has hecho, activa la reserva en Mi disponibilidad.
              </EmptyState>
            ) : (
              <EmptyState icon="clock" title="Aún no hay solicitudes respondidas">Aquí quedarán las que aceptes, rechaces o caduquen.</EmptyState>
            )}
          </section>
        )}

        {state === 'ready' && items.length > 0 && (
          <ul className="bk-req-list">
            {items.map((request) => (
              <RequestCard key={request.id} request={request} showTherapist={showTherapist} busy={busy} onApprove={approve} onReject={setRejecting} />
            ))}
          </ul>
        )}

        <RejectRequestDialog open={rejecting !== null} onConfirm={reject} onClose={() => setRejecting(null)} />
      </main>
    </div>
  );
}
