'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import NewProcessForm from '@/components/NewProcessForm';
import { api } from '@/lib/api';
import {
  canManageProcess,
  ClinicalProcessRow,
  isForbidden,
  isStaffWithProcessAccess,
  modalityLabel,
  processLabel,
  processTitle,
  ProcessStatus,
  therapistName,
  useViewer,
} from '@/lib/clinical';

/** GET /clinical-processes/:id (solo con acceso clínico). `internalNotes` solo llega a su autor. */
type ProcessDetail = {
  id: string;
  patientId: string;
  therapistId: string;
  title: string | null;
  status: ProcessStatus;
  modality?: string | null;
  frequency?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  consultationReason?: string | null;
  goals?: string | null;
  internalNotes?: string | null;
  readOnly: boolean;
  therapist?: { id: string; firstName: string; lastName: string } | null;
  patient?: { id: string; firstName: string; lastName: string } | null;
  sessions?: Array<{ id: string; startsAt: string; status: string; type?: string | null }>;
};

type PatientHeader = { id: string; firstName: string; lastName: string };

const SESSION_STATUS: Record<string, string> = { SCHEDULED: 'Programada', COMPLETED: 'Completada', CANCELLED: 'Cancelada', NO_SHOW: 'No asistió' };

function formatDate(value?: string | null, withTime = false) {
  if (!value) return 'Sin registrar';
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value));
}

function readOnlyReason(detail: ProcessDetail, isAuthor: boolean): string {
  if (!isAuthor) return 'Este proceso es de otro profesional: puedes consultarlo, pero solo su autor lo modifica.';
  if (detail.status === 'PAUSED') return 'El proceso está en pausa. Reactívalo para volver a registrar contenido clínico.';
  if (detail.status === 'DISCHARGED') return 'El proceso está de alta. Reábrelo si el paciente vuelve a consulta.';
  if (detail.status === 'CLOSED') return 'El proceso está cerrado. Conservas la lectura de lo que registraste.';
  return 'Ahora mismo no puedes modificar este proceso.';
}

export default function ProcessPage() {
  const { id: patientId, processId } = useParams<{ id: string; processId: string }>();
  const router = useRouter();
  const viewer = useViewer();
  const [patient, setPatient] = useState<PatientHeader | null>(null);
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  // Sin acceso al contenido: metadatos del listado (estado, modalidad, profesional).
  const [summary, setSummary] = useState<ClinicalProcessRow | null>(null);
  const [state, setState] = useState<'loading' | 'clinical' | 'administrative' | 'no-module' | 'error'>('loading');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);

  async function load() {
    setError('');
    try {
      const patientRow = await api<PatientHeader>(`/patients/${patientId}`);
      setPatient(patientRow);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el paciente');
      setState('error');
      return;
    }
    if (!isStaffWithProcessAccess(viewer?.role)) {
      // ASSISTANT: no entra en el módulo de procesos; no se le pide nada a la API.
      setState('no-module');
      return;
    }
    // Primero el listado (metadatos + canReadClinical): sin acceso al contenido no se pide el
    // detalle, que respondería 403 y dejaría una denegación auditada en cada visita.
    let row: ClinicalProcessRow | null = null;
    try {
      const list = await api<{ data: ClinicalProcessRow[] }>(`/clinical-processes?patientId=${encodeURIComponent(patientId)}&pageSize=100`);
      row = list.data.find((item) => item.id === processId) ?? null;
    } catch (err) {
      if (!isForbidden(err)) {
        setError(err instanceof Error ? err.message : 'No se pudo cargar el proceso');
        setState('error');
        return;
      }
    }
    if (row?.canReadClinical !== true) {
      setDetail(null);
      setSummary(row);
      setState('administrative');
      return;
    }
    try {
      const data = await api<ProcessDetail>(`/clinical-processes/${processId}`);
      setDetail(data);
      setSummary(null);
      setState('clinical');
    } catch (err) {
      if (!isForbidden(err)) {
        setError(err instanceof Error ? err.message : 'No se pudo cargar el proceso');
        setState('error');
        return;
      }
      setDetail(null);
      setSummary(row);
      setState('administrative');
    }
  }

  useEffect(() => {
    if (!patientId || !processId || !viewer) return;
    // Nunca mostrar datos del proceso anterior mientras carga el nuevo.
    setDetail(null);
    setSummary(null);
    setSwitching(false);
    setStatus('');
    setState('loading');
    load();
  }, [patientId, processId, viewer]);

  const meta = detail ?? summary;
  const isAuthor = Boolean(detail && (viewer?.userId ? detail.therapistId === viewer.userId : Object.prototype.hasOwnProperty.call(detail, 'internalNotes')));
  const readOnly = detail ? detail.readOnly || detail.status !== 'ACTIVE' : true;
  const canManage = meta ? canManageProcess(viewer, meta) : false;

  async function changeStatus(next: ProcessStatus, message: string) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await api(`/clinical-processes/${processId}/status`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      setStatus(message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cambiar el estado del proceso');
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || readOnly) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await api(`/clinical-processes/${processId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: String(data.get('title') ?? '').trim() || undefined,
          consultationReason: String(data.get('consultationReason') ?? ''),
          goals: String(data.get('goals') ?? ''),
          ...(isAuthor ? { internalNotes: String(data.get('internalNotes') ?? '') } : {}),
        }),
      });
      setStatus('Proceso guardado.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el proceso');
    } finally {
      setBusy(false);
    }
  }

  async function closeCurrent() {
    if (!meta) return;
    if (meta.status === 'ACTIVE' || meta.status === 'PAUSED') {
      await api(`/clinical-processes/${processId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'CLOSED' }) });
    }
  }

  if (!viewer || state === 'loading') {
    return <div className="app-layout"><Sidebar /><main className="patient-record-page"><div className="patient-record-loading" role="status">Cargando proceso…</div></main></div>;
  }

  if (state === 'error') {
    return (
      <div className="app-layout"><Sidebar /><main className="patient-record-page">
        <div className="agenda-error" role="alert">{error || 'No se pudo cargar el proceso'}</div>
        <div className="e1-actions"><button type="button" className="button secondary" onClick={load}>Reintentar</button><Link href={`/patients/${patientId}`} className="button secondary">Volver a la ficha</Link></div>
      </main></div>
    );
  }

  if (state === 'no-module') {
    return (
      <div className="app-layout"><Sidebar /><main className="patient-record-page">
        <Link href={`/patients/${patientId}`} className="patient-record-back">← Volver a la ficha{patient ? ` de ${patient.firstName} ${patient.lastName}` : ''}</Link>
        <div className="patient-record-kicker">Proceso clínico</div>
        <h1>Proceso clínico</h1>
        <div className="e1-notice info" role="note"><div><strong>Gestión reservada al equipo clínico y a administración</strong><p>Los procesos clínicos los gestionan los profesionales y la administración de la consulta. Desde la ficha del paciente puedes seguir con su agenda y su portal.</p></div></div>
      </main></div>
    );
  }

  const title = detail ? processTitle(detail) : meta ? processLabel(meta) : 'Proceso clínico';
  const canReactivate = canManage && meta && (meta.status === 'PAUSED' || meta.status === 'DISCHARGED');

  return (
    <div className="app-layout"><Sidebar /><main className="patient-record-page">
      <header className="patient-record-header">
        <div>
          <Link href={`/patients/${patientId}`} className="patient-record-back">← Volver a la ficha{patient ? ` de ${patient.firstName} ${patient.lastName}` : ''}</Link>
          <div className="patient-record-kicker">Proceso clínico</div>
          <h1>{title}</h1>
          <div className="e1-actions" style={{ marginTop: 6 }}>
            {meta && <span className={`e1-badge ${meta.status === 'ACTIVE' ? 'active' : ''}`}>{processLabel({ status: meta.status })}</span>}
            {state === 'clinical' && readOnly && <span className="e1-badge readonly">Solo lectura</span>}
          </div>
        </div>
      </header>

      {error && <div className="agenda-error" role="alert">{error}</div>}
      <p className={status ? 'patient-save-state' : undefined} role="status" aria-live="polite">{status}</p>

      {state === 'administrative' && (
        <div className="e1-notice info" role="note">
          <div>
            <strong>Contenido clínico reservado</strong>
            <p>Solo su terapeuta puede ver el contenido clínico de este proceso. Aquí tienes los datos de gestión.</p>
          </div>
        </div>
      )}

      {state === 'clinical' && detail && readOnly && (
        <div className="e1-notice" role="note">
          <div>
            <strong>Solo lectura</strong>
            <p>{readOnlyReason(detail, isAuthor)}</p>
          </div>
          {canReactivate && (
            <div className="e1-notice-actions">
              <button type="button" className="button" disabled={busy} onClick={() => changeStatus('ACTIVE', 'Proceso reactivado.')}>
                {meta?.status === 'DISCHARGED' ? 'Reabrir proceso' : 'Reactivar proceso'}
              </button>
            </div>
          )}
        </div>
      )}

      {state === 'administrative' && canReactivate && (
        <div className="e1-notice" role="note">
          <div><strong>{meta?.status === 'PAUSED' ? 'Proceso en pausa' : 'Proceso de alta'}</strong><p>Puedes reactivarlo como gestión de la consulta; su contenido seguirá siendo de su terapeuta.</p></div>
          <div className="e1-notice-actions"><button type="button" className="button" disabled={busy} onClick={() => changeStatus('ACTIVE', 'Proceso reactivado.')}>{meta?.status === 'DISCHARGED' ? 'Reabrir proceso' : 'Reactivar proceso'}</button></div>
        </div>
      )}

      <div className="e1-stack">
        <section className="patient-record-card">
          <h2>Datos del proceso</h2>
          {meta ? (
            <dl className="e1-meta">
              <div><dt>Profesional</dt><dd>{therapistName(meta.therapist)}</dd></div>
              <div><dt>Estado</dt><dd>{processLabel({ status: meta.status })}</dd></div>
              <div><dt>Modalidad</dt><dd>{modalityLabel(meta.modality) ?? 'No definida'}</dd></div>
              <div><dt>Frecuencia</dt><dd>{meta.frequency || 'No definida'}</dd></div>
              <div><dt>Inicio</dt><dd>{formatDate(meta.startedAt)}</dd></div>
              {meta.endedAt && <div><dt>Fin</dt><dd>{formatDate(meta.endedAt)}</dd></div>}
            </dl>
          ) : (
            <p className="muted">Este proceso no figura entre los que puedes consultar o gestionar.</p>
          )}
        </section>

        {state === 'clinical' && detail && (readOnly ? (
          <section className="patient-record-card" aria-label="Contenido clínico (solo lectura)">
            <h2>Contenido clínico</h2>
            <h3>Motivo de consulta</h3>
            <p className="e1-readonly-text">{detail.consultationReason || 'Sin registrar'}</p>
            <h3>Objetivos</h3>
            <p className="e1-readonly-text">{detail.goals || 'Sin registrar'}</p>
            {isAuthor && <><h3>Notas internas</h3><p className="e1-readonly-text">{detail.internalNotes || 'Sin registrar'}</p></>}
          </section>
        ) : (
          <form className="patient-record-card e1-form" style={{ maxWidth: 'none' }} onSubmit={save}>
            <h2>Contenido clínico</h2>
            <label className="field">Nombre del proceso<input name="title" defaultValue={detail.title ?? ''} minLength={2} maxLength={160} /></label>
            <label className="field">Motivo de consulta<textarea name="consultationReason" defaultValue={detail.consultationReason ?? ''} maxLength={4000} rows={4} /></label>
            <label className="field">Objetivos<textarea name="goals" defaultValue={detail.goals ?? ''} maxLength={6000} rows={4} /></label>
            {isAuthor && <label className="field">Notas internas (solo tú)<textarea name="internalNotes" defaultValue={detail.internalNotes ?? ''} maxLength={6000} rows={4} /></label>}
            <div className="e1-actions"><button className="button" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</button></div>
          </form>
        ))}

        {state === 'clinical' && detail && (
          <section className="patient-record-card">
            <h2>Sesiones del proceso</h2>
            {detail.sessions && detail.sessions.length > 0 ? (
              <ul className="e1-list">
                {detail.sessions.map((session) => (
                  <li key={session.id} className="e1-row">
                    <div><strong>{formatDate(session.startsAt, true)}</strong></div>
                    <div><span className="e1-badge">{SESSION_STATUS[session.status] ?? session.status}</span></div>
                    <div><Link href={`/agenda/${session.id}`} className="button secondary">Abrir sesión</Link></div>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">Este proceso todavía no tiene sesiones.</p>}
          </section>
        )}

        {meta && canManage && meta.status !== 'CLOSED' && (
          <section className="patient-record-card">
            <h2>Gestión del proceso</h2>
            {meta.status === 'ACTIVE' && (
              <div className="e1-actions">
                <button type="button" className="button secondary" disabled={busy} onClick={() => changeStatus('PAUSED', 'Proceso en pausa.')}>Pausar</button>
                <button type="button" className="button secondary" disabled={busy} onClick={() => { if (window.confirm('¿Dar de alta este proceso? Quedará en solo lectura.')) changeStatus('DISCHARGED', 'Proceso dado de alta.'); }}>Dar de alta</button>
              </div>
            )}
            <h3 style={{ marginTop: 22 }}>¿Cambiar de profesional?</h3>
            <p className="muted">
              Un proceso no se reasigna: su contenido pertenece a quien lo registró. Para que otro profesional atienda al
              paciente, cierra este proceso y abre uno nuevo a su nombre. El historial queda con su autor.
            </p>
            {!switching ? (
              <button type="button" className="button secondary" onClick={() => setSwitching(true)}>Cerrar este proceso y abrir uno nuevo</button>
            ) : viewer && (
              <NewProcessForm
                patientId={patientId}
                viewer={viewer}
                heading="Nuevo proceso"
                submitLabel={meta.status === 'DISCHARGED' ? 'Abrir proceso nuevo' : 'Cerrar este proceso y abrir el nuevo'}
                confirm={() => meta.status === 'DISCHARGED' || window.confirm('Se abrirá el proceso nuevo y, después, se cerrará el actual (no se puede deshacer). ¿Continuar?')}
                // Primero se crea el nuevo; solo si sale bien se cierra el actual.
                afterCreate={async () => {
                  try {
                    await closeCurrent();
                  } catch (err) {
                    throw new Error(`el proceso anterior sigue abierto (${err instanceof Error ? err.message : 'error'}); ciérralo desde su ficha`);
                  }
                }}
                onCreated={(created) => router.push(`/patients/${patientId}/processes/${created.id}`)}
                onCancel={() => setSwitching(false)}
              />
            )}
          </section>
        )}
      </div>
    </main></div>
  );
}
