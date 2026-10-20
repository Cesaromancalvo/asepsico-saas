'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PortalSignupAcceptedContract, SchedulingProfessionalContract } from '@asepsico/contracts';
import Sidebar from '@/components/Sidebar';
import Icon, { EmptyState } from '@/components/Icon';
import SignupRequestCard from '@/components/SignupRequestCard';
import LinkPatientDialog from '@/components/LinkPatientDialog';
import ActivationDialog from '@/components/ActivationDialog';
import { ApiError } from '@/lib/api';
import { listProfessionals } from '@/lib/booking-client';
import { isAdminRole, isForbidden, useViewer } from '@/lib/clinical';
import {
  acceptCreatingPatient, listSignupRequests, rejectSignupRequest, rejectSignupRequests, SignupRequest,
} from '@/lib/portal-signup';

type State = 'loading' | 'ready' | 'error' | 'forbidden';
type Accepted = { result: PortalSignupAcceptedContract; name: string; context: string };

function acceptErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'PORTAL_SIGNUP_MANUAL_WITH_GUARDIAN') return 'Esta persona tiene menos de 16 años: el alta se hace a mano, con su madre, padre o tutor.';
    if (err.status === 404) return 'Esta solicitud ya no existe: puede que otra persona la haya resuelto o que haya caducado.';
    if (err.status === 409) return err.message || 'La solicitud ya se ha resuelto. Recarga la bandeja.';
    if (err.message) return err.message;
  }
  return 'No se ha podido aceptar la solicitud. Vuelve a intentarlo.';
}

/**
 * Bandeja de solicitudes de alta en el portal (QR fijo de cada profesional). Cada terapeuta ve las
 * suyas; recepción, titular y administración las de toda la consulta. Las de un profesional dado
 * de baja solo llegan a titular y administración, con una etiqueta neutra.
 */
export default function PortalSignupsPage() {
  const viewer = useViewer();
  const [state, setState] = useState<State>('loading');
  const [items, setItems] = useState<SignupRequest[]>([]);
  const [professionals, setProfessionals] = useState<SchedulingProfessionalContract[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [linking, setLinking] = useState<SignupRequest | null>(null);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const isAdmin = isAdminRole(viewer?.role);
  const showProfessional = viewer?.role !== 'THERAPIST';

  const load = useCallback(async (professionalId: string) => {
    setState('loading');
    setError('');
    try {
      const rows = await listSignupRequests(professionalId || undefined);
      setItems(rows);
      setSelectedIds((current) => new Set([...current].filter((id) => rows.some((row) => row.id === id))));
      setState('ready');
    } catch (err) {
      if (isForbidden(err)) { setState('forbidden'); return; }
      setError(err instanceof Error && err.message ? err.message : 'No se han podido cargar las solicitudes.');
      setState('error');
    }
  }, []);

  useEffect(() => { void load(filter); }, [filter, load]);

  useEffect(() => {
    listProfessionals().then((data) => setProfessionals(data.professionals)).catch(() => setProfessionals([]));
  }, []);

  const nameOf = useMemo(() => {
    const map = new Map(professionals.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? 'un profesional de la consulta';
  }, [professionals]);

  function toggle(request: SignupRequest, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(request.id); else next.delete(request.id);
      return next;
    });
    setConfirmBulk(false);
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(items.map((item) => item.id)) : new Set());
    setConfirmBulk(false);
  }

  async function createPatient(request: SignupRequest) {
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await acceptCreatingPatient(request.id);
      setAccepted({ result, name: request.firstName, context: 'Paciente nuevo creado' });
      setStatus(`Solicitud aceptada: ${request.firstName} ${request.lastName} ya tiene ficha y su cuenta del portal espera la activación.`);
      await load(filter);
    } catch (err) {
      setError(acceptErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function reject(request: SignupRequest) {
    setBusy(true); setError(''); setStatus('');
    try {
      await rejectSignupRequest(request.id);
      setStatus(`Solicitud de ${request.firstName} ${request.lastName} rechazada.`);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'Esa solicitud ya no existe.' : err instanceof Error && err.message ? err.message : 'No se ha podido rechazar.');
    } finally {
      setBusy(false);
      await load(filter);
    }
  }

  async function rejectSelected() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBusy(true); setError(''); setStatus(''); setConfirmBulk(false);
    try {
      const result = await rejectSignupRequests(ids);
      const done = result.rejected === 1 ? 'Se ha rechazado 1 solicitud.' : `Se han rechazado ${result.rejected} solicitudes.`;
      const missing = result.notFound > 0 ? ` ${result.notFound} ya estaban resueltas o habían caducado.` : '';
      setStatus(done + missing);
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'No se han podido rechazar las solicitudes.');
    } finally {
      setBusy(false);
      await load(filter);
    }
  }

  const selectedCount = selectedIds.size;
  const allSelected = items.length > 0 && selectedCount === items.length;

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="dashboard">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Portal del paciente</p>
            <h1>Altas del portal</h1>
            <p className="dashboard-subtitle">
              Personas que han escaneado un QR de alta. Comprueba su identidad en persona, vincúlalas a su ficha o crea una nueva y entrégales el acceso.
            </p>
          </div>
          {viewer && viewer.role !== 'ASSISTANT' && (
            <div className="dashboard-actions">
              <Link href="/settings/portal-qr" className="agenda-navigation-button"><Icon name="qr" size={18} />{isAdmin ? 'QR de alta' : 'Mi QR de alta'}</Link>
            </div>
          )}
        </header>

        {showProfessional && professionals.length > 1 && (
          <div className="ps-toolbar">
            <label className="ps-filter">
              <span>Profesional</span>
              <select value={filter} onChange={(event) => { setFilter(event.target.value); setSelectedIds(new Set()); }}>
                <option value="">Todos</option>
                {professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>
        )}

        <p className={status ? 'patient-save-state' : 'bk-live'} role="status" aria-live="polite">{status}</p>
        {error && state !== 'error' && <div className="agenda-error" role="alert">{error}</div>}

        {state === 'loading' && <section className="dashboard-card dashboard-loading" role="status">Cargando solicitudes…</section>}

        {state === 'forbidden' && (
          <section className="dashboard-card">
            <EmptyState icon="lock" title="Sin acceso a esta sección">Las altas del portal las revisa el equipo de la consulta.</EmptyState>
          </section>
        )}

        {state === 'error' && (
          <section className="dashboard-card dashboard-error" role="alert">
            <p>{error}</p>
            <button type="button" className="button secondary" onClick={() => void load(filter)}>Intentar de nuevo</button>
          </section>
        )}

        {state === 'ready' && items.length === 0 && (
          <section className="dashboard-card">
            <EmptyState icon="inbox" title="No hay solicitudes pendientes">
              Cuando alguien escanee un QR de alta y envíe sus datos, aparecerá aquí. Las solicitudes sin respuesta se borran solas a los 14 días.
            </EmptyState>
          </section>
        )}

        {state === 'ready' && items.length > 0 && (
          <>
            <div className="ps-bulkbar" role="group" aria-label="Acciones con varias solicitudes">
              <label className="ps-bulk-all">
                <input type="checkbox" checked={allSelected} disabled={busy} onChange={(event) => toggleAll(event.target.checked)} />
                <span>{selectedCount > 0 ? `${selectedCount} seleccionada${selectedCount === 1 ? '' : 's'}` : `Seleccionar todas (${items.length})`}</span>
              </label>
              {selectedCount > 0 && !confirmBulk && (
                <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmBulk(true)}>
                  Rechazar {selectedCount === 1 ? 'la seleccionada' : `las ${selectedCount} seleccionadas`}
                </button>
              )}
              {confirmBulk && (
                <div className="bk-inline-confirm ps-bulk-confirm">
                  <span>Se borrarán {selectedCount === 1 ? 'la solicitud' : `${selectedCount} solicitudes`}. No se avisa a nadie.</span>
                  <button type="button" className="button danger" disabled={busy} onClick={() => void rejectSelected()}>Sí, rechazar</button>
                  <button type="button" className="bk-link-button" onClick={() => setConfirmBulk(false)}>Volver</button>
                </div>
              )}
            </div>
            <ul className="bk-req-list">
              {items.map((request) => (
                <SignupRequestCard
                  key={request.id}
                  request={request}
                  professionalName={showProfessional ? nameOf(request.professionalId) : null}
                  selected={selectedIds.has(request.id)}
                  busy={busy}
                  onToggle={toggle}
                  onCreate={(r) => void createPatient(r)}
                  onLink={setLinking}
                  onReject={(r) => void reject(r)}
                />
              ))}
            </ul>
          </>
        )}

        <LinkPatientDialog
          request={linking}
          onClose={() => setLinking(null)}
          onLinked={(result, request, patient) => {
            setAccepted({ result, name: patient.firstName, context: `Vinculada a la ficha de ${patient.firstName} ${patient.lastName}` });
            setStatus(`Solicitud de ${request.firstName} ${request.lastName} vinculada. Su cuenta del portal espera la activación.`);
            void load(filter);
          }}
        />
        <ActivationDialog
          result={accepted?.result ?? null}
          personName={accepted?.name}
          context={accepted?.context}
          onClose={() => setAccepted(null)}
        />
      </main>
    </div>
  );
}
