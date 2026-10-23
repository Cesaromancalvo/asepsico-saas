'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ExceptionalAccessRegisterResponse, OwnerReviewOutcome, ReviewResponse } from '@asepsico/contracts';
import Sidebar from '@/components/Sidebar';
import JustificationDialog from '@/components/JustificationDialog';
import { EmptyState } from '@/components/Icon';
import { api, ApiError } from '@/lib/api';
import { isAdminRole, ROLE_LABEL, useViewer } from '@/lib/clinical';
import { formatDateTime, pendingReviews, registerRows, reviewDueText, type RegisterRow } from '@/lib/exceptional-access';

type Member = { userId: string; firstName: string | null; lastName: string | null; email?: string | null };

/**
 * Registro de accesos excepcionales y aperturas sobre historia ajena (§3.7, H4).
 * OWNER: todo el workspace, revisiones de 72 h, explicación (con lectura auditada) y avisos
 * diferidos. ADMIN: solo lo suyo y sin acciones. Ningún listado muestra la explicación.
 */
export default function ExceptionalAccessRegisterPage() {
  const viewer = useViewer();
  const isOwner = viewer?.role === 'OWNER';
  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [reading, setReading] = useState<{ id: string; blocked: boolean; summary: string } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [register, members] = await Promise.all([
        api<ExceptionalAccessRegisterResponse>('/exceptional-access'),
        api<Member[]>('/workspace-members').catch(() => [] as Member[]),
      ]);
      setRows(registerRows(register));
      setNames(new Map(members.map((m) => [m.userId, [m.firstName, m.lastName].filter(Boolean).join(' ').trim() || m.email || 'Miembro del equipo'])));
      setState('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) { setState('forbidden'); return; }
      setError(err instanceof Error ? err.message : 'No se pudo cargar el registro');
      setState('error');
    }
  }, []);

  useEffect(() => {
    if (!viewer) return;
    if (!isAdminRole(viewer.role)) { setState('forbidden'); return; }
    load();
  }, [viewer, load]);

  const person = (row: RegisterRow) => `${row.actorId === viewer?.userId ? 'Tú' : names.get(row.actorId) ?? 'Miembro del equipo'} (${ROLE_LABEL[row.actorRole]})`;

  async function review(row: RegisterRow, outcome: OwnerReviewOutcome) {
    setBusyId(row.id); setRowError(null); setMessage('');
    try {
      const path = row.kind === 'ACCESS' ? `/exceptional-access/${row.id}/review` : `/exceptional-access/openings/${row.id}/review`;
      const result = await api<ReviewResponse>(path, { method: 'POST', body: JSON.stringify({ outcome }) });
      setMessage(result.selfReview ? 'Revisión guardada. Queda marcada como autorrevisión.' : 'Revisión guardada.');
      await load();
    } catch (err) {
      const text = err instanceof ApiError && err.status === 403 ? 'Esta revisión la tiene que hacer otro titular de la consulta.' : err instanceof Error ? err.message : 'No se pudo guardar la revisión';
      setRowError({ id: row.id, text });
    } finally { setBusyId(null); }
  }

  async function release(row: RegisterRow) {
    if (!window.confirm('Se enviará ahora el aviso al terapeuta del paciente. ¿Liberar el aviso?')) return;
    setBusyId(row.id); setRowError(null); setMessage('');
    try {
      await api(`/exceptional-access/${row.id}/release-notice`, { method: 'POST' });
      setMessage('Aviso liberado: el terapeuta ya lo tiene en Avisos.');
      await load();
    } catch (err) {
      setRowError({ id: row.id, text: err instanceof Error ? err.message : 'No se pudo liberar el aviso' });
    } finally { setBusyId(null); }
  }

  const pending = pendingReviews(rows);
  const deferred = rows.filter((row) => row.noticeDeferred);

  return (
    <div className="app-layout"><Sidebar /><main className="patient-record-page">
      <header className="patient-record-header"><div>
        <span className="eyebrow">Seguridad</span>
        <h1>Accesos excepcionales</h1>
        <p>{isOwner
          ? 'Quién ha abierto la historia de un paciente sin atenderle, y quién ha abierto o reactivado un proceso sobre la historia de otro profesional. Aquí no se muestra ninguna explicación.'
          : 'Los accesos excepcionales y las aperturas de proceso que has registrado tú. La revisión la hace la persona titular de la consulta.'}</p>
      </div></header>

      {state === 'loading' && <div className="patient-record-loading" role="status">Cargando registro…</div>}
      {state === 'forbidden' && <div className="e1-notice info" role="note"><div><strong>Solo para la dirección de la consulta</strong><p>Este registro lo ven la persona titular y administración.</p></div></div>}
      {state === 'error' && <div className="agenda-error" role="alert">{error} <button type="button" className="button secondary" onClick={load}>Reintentar</button></div>}
      {message && <p className="patient-save-state" role="status">{message}</p>}

      {state === 'ready' && (<>
        {isOwner && (
          <section className="patient-card xa-section" aria-labelledby="xa-pending-heading">
            <h2 id="xa-pending-heading">Pendiente de revisar (72 horas)</h2>
            <p className="muted">Urgencias y procesos que alguien de la dirección se ha abierto a sí mismo. Es un control posterior: el acceso ya se concedió.</p>
            {pending.length === 0 ? <p className="xa-empty">No hay nada pendiente de revisar.</p> : (
              <div className="xa-pending">
                {pending.map((row) => (
                  <article key={row.id} className="xa-pending-item">
                    <div>
                      <strong>{row.typeLabel} · {row.patientInitials}</strong>
                      <small>{formatDateTime(row.createdAt)} · {person(row)} · {row.reasonLabel}</small>
                      <small>{reviewDueText(row.reviewDueAt)}</small>
                      {row.actorId === viewer?.userId && <small>Lo registraste tú: si eras el único titular en ese momento, quedará como autorrevisión; si no, lo revisa otro titular.</small>}
                      {rowError?.id === row.id && <p className="xa-field-error" role="alert">{rowError.text}</p>}
                    </div>
                    <div className="xa-pending-actions">
                      <button type="button" className="button secondary" disabled={busyId === row.id} onClick={() => review(row, 'CORRECT')}>Revisado, correcto</button>
                      <button type="button" className="button secondary" disabled={busyId === row.id} onClick={() => review(row, 'INCIDENT')}>Revisado, incidencia</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {isOwner && deferred.length > 0 && (
          <section className="patient-card xa-section" aria-labelledby="xa-deferred-heading">
            <h2 id="xa-deferred-heading">Avisos diferidos</h2>
            <p className="muted">El terapeuta aún no sabe que se accedió a la historia. Te lo recordaremos cada 30 días hasta que lo liberes.</p>
            <div className="xa-pending">
              {deferred.map((row) => (
                <article key={row.id} className="xa-pending-item">
                  <div>
                    <strong>{row.patientInitials} · {row.reasonLabel}</strong>
                    <small>{formatDateTime(row.createdAt)} · {person(row)}</small>
                    {rowError?.id === row.id && <p className="xa-field-error" role="alert">{rowError.text}</p>}
                  </div>
                  <div className="xa-pending-actions"><button type="button" className="button" disabled={busyId === row.id} onClick={() => release(row)}>Liberar aviso</button></div>
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="patient-card xa-section" aria-labelledby="xa-list-heading">
          <h2 id="xa-list-heading">Registro</h2>
          {rows.length === 0 ? (
            <EmptyState icon="shield" title="Todavía no hay ningún registro.">Cuando alguien de la dirección abra una historia de forma excepcional, o un proceso sobre la historia de otro profesional, aparecerá aquí.</EmptyState>
          ) : (
            <div className="xa-table-wrap">
              <table className="xa-table">
                <caption className="sr-only">Accesos excepcionales y aperturas de proceso, del más reciente al más antiguo</caption>
                <thead><tr><th scope="col">Fecha</th><th scope="col">Tipo</th><th scope="col">Persona</th><th scope="col">Paciente</th><th scope="col">Motivo</th><th scope="col">Estado</th>{isOwner && <th scope="col"><span className="sr-only">Acciones</span></th>}</tr></thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.kind}-${row.id}`}>
                      <td data-label="Fecha">{formatDateTime(row.createdAt)}</td>
                      <td data-label="Tipo">{row.typeLabel}</td>
                      <td data-label="Persona">{person(row)}</td>
                      <td data-label="Paciente">{row.patientInitials}</td>
                      <td data-label="Motivo">{row.reasonLabel}</td>
                      <td data-label="Estado"><span className={`status-pill ${row.statusTone}`}>{row.statusLabel}</span></td>
                      {isOwner && <td>{row.kind === 'ACCESS' && (
                        <button type="button" className="small-secondary" onClick={() => setReading({ id: row.id, blocked: row.blocked, summary: `${formatDateTime(row.createdAt)} · ${person(row)} · paciente ${row.patientInitials} · ${row.reasonLabel}` })}>Ver explicación</button>
                      )}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {isOwner && (
          <section className="patient-card xa-section" aria-labelledby="xa-miss-heading">
            <h2 id="xa-miss-heading">«Mi motivo no está en la lista»</h2>
            <p className="muted">Cuando alguien pulsa este enlace en el formulario de acceso, no se abre nada: se le pide que consulte con la dirección. Solo se cuenta cuántas veces pasa (sin paciente, persona ni texto) para revisar la lista de motivos con las consultas del piloto. Si te ocurre a menudo, cuéntanoslo.</p>
            <Link href="/settings/security" className="text-link">Volver a Seguridad</Link>
          </section>
        )}
      </>)}

      <JustificationDialog access={reading} onClose={() => setReading(null)} />
    </main></div>
  );
}
