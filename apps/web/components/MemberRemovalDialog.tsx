'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import type { MemberRemovalPreviewContract, MemberRemovalReason } from '@asepsico/contracts';
import { ROLE_LABEL } from '@/lib/clinical';
import {
  getRemovalPreview, hasPendingWork, pendingSummary, reassignMemberWork, REMOVAL_REASON_LABEL, REMOVAL_REASONS,
  removalErrorMessage, removalSummaryLines, removeMember,
} from '@/lib/member-removal';

export type RemovalTarget = { userId: string; name: string; mode: 'remove' | 'reassign' };

type Props = {
  /** null = cerrado. 'remove': dar de baja. 'reassign': pasar después el trabajo de alguien ya de baja. */
  target: RemovalTarget | null;
  onClose: () => void;
  /** Tras una baja o reasignación correcta (para recargar la lista y anunciar el resumen). */
  onDone: (summary: string) => void;
};

type Phase = 'loading' | 'form' | 'done' | 'error';

const targetName = (t: { firstName: string | null; lastName: string | null }) => [t.firstName, t.lastName].filter(Boolean).join(' ') || 'Profesional sin nombre';

/**
 * Baja de un miembro (o reasignación posterior de su trabajo). Muestra antes de confirmar cuántos
 * procesos y citas tiene, deja elegir a quién pasarlos o «Decidir después», y explica que no se
 * borra nada y que sus notas internas no pasan al destino. Errores 400/409 con mensaje claro.
 */
export default function MemberRemovalDialog({ target, onClose, onDone }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const [phase, setPhase] = useState<Phase>('loading');
  const [preview, setPreview] = useState<MemberRemovalPreviewContract | null>(null);
  const [reason, setReason] = useState<MemberRemovalReason | ''>('');
  const [destination, setDestination] = useState<'later' | 'reassign'>('reassign');
  const [toUserId, setToUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<string[]>([]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (target && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      setPhase('loading'); setPreview(null); setReason(''); setDestination('reassign'); setToUserId(''); setBusy(false); setError(''); setSummary([]);
      dialog.showModal();
      requestAnimationFrame(() => headingRef.current?.focus());
      getRemovalPreview(target.userId)
        .then((data) => {
          setPreview(data);
          setToUserId(data.reassignTargets[0]?.userId ?? '');
          setDestination(data.reassignTargets.length ? 'reassign' : 'later');
          setPhase('form');
        })
        .catch((err: unknown) => { setError(removalErrorMessage(err, { member: target.name })); setPhase('error'); });
    } else if (!target && dialog.open) {
      dialog.close();
    }
  }, [target]);

  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (phase === 'done') doneRef.current?.focus(); }, [phase]);
  // La ventana puede ser más alta que la pantalla: el error se trae a la vista.
  useEffect(() => { if (error && phase === 'form') errorRef.current?.scrollIntoView({ block: 'center' }); }, [error, phase]);

  function handleClosed() {
    onClose();
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    if (back && document.contains(back)) back.focus();
  }

  if (!target) return <dialog ref={dialogRef} className="agenda-modal ps-dialog" onClose={handleClosed} />;

  const pending = preview ? hasPendingWork(preview) : false;
  const isReassign = target.mode === 'reassign';
  const chosen = preview?.reassignTargets.find((t) => t.userId === toUserId) ?? null;
  const chosenName = chosen ? targetName(chosen) : null;
  const reassigning = pending && destination === 'reassign' && Boolean(toUserId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!target || !preview) return;
    if (isReassign && !toUserId) { setError('Elige a quién pasar su trabajo.'); return; }
    setBusy(true); setError('');
    try {
      const lines = isReassign
        ? removalSummaryLines(target.name, await reassignMemberWork(target.userId, toUserId), chosenName)
        : removalSummaryLines(
            target.name,
            await removeMember(target.userId, { ...(reason ? { reason } : {}), ...(reassigning ? { reassignToUserId: toUserId } : {}) }),
            chosenName,
          );
      setSummary(lines);
      setPhase('done');
      onDone(isReassign ? `Trabajo de ${target.name} reasignado.` : `${target.name} se ha dado de baja.`);
    } catch (err) {
      setError(removalErrorMessage(err, { member: target.name, target: chosenName }));
    } finally {
      setBusy(false);
    }
  }

  const title = isReassign ? `Pasar el trabajo de ${target.name}` : `Dar de baja a ${target.name}`;

  return (
    <dialog
      ref={dialogRef}
      className="agenda-modal ps-dialog"
      aria-labelledby={`${id}-title`}
      onClose={handleClosed}
      onCancel={(event) => { if (busy) event.preventDefault(); }}
    >
      <div className="agenda-modal-header">
        <div>
          {preview && <p className="ps-dialog-kicker">{ROLE_LABEL[preview.role] ?? preview.role}</p>}
          <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1}>{phase === 'done' ? (isReassign ? 'Trabajo reasignado' : 'Baja hecha') : title}</h2>
        </div>
        <button type="button" aria-label="Cerrar" disabled={busy} onClick={() => dialogRef.current?.close()}>×</button>
      </div>

      {phase === 'loading' && <p role="status" className="ps-dialog-text">Comprobando qué tiene a su nombre…</p>}

      {phase === 'error' && (
        <>
          <p className="agenda-error" role="alert">{error}</p>
          <div className="agenda-modal-actions"><button type="button" className="button secondary" onClick={() => dialogRef.current?.close()}>Cerrar</button></div>
        </>
      )}

      {phase === 'done' && (
        <div className="mr-done">
          <h3 ref={doneRef} tabIndex={-1} className="sr-only">Resumen</h3>
          <ul className="mr-summary">{summary.map((line) => <li key={line}>{line}</li>)}</ul>
          <p className="mr-keep">No se ha borrado nada: lo que escribió sigue en la consulta con su nombre.</p>
          <div className="agenda-modal-actions"><button type="button" className="button" onClick={() => dialogRef.current?.close()}>Cerrar</button></div>
        </div>
      )}

      {phase === 'form' && preview && (
        <form onSubmit={submit} noValidate>
          <div className="mr-counts" aria-label="Lo que tiene a su nombre">
            <div><strong>{preview.activeProcesses}</strong><span>{preview.activeProcesses === 1 ? 'proceso activo' : 'procesos activos'}</span></div>
            <div><strong>{preview.pausedProcesses}</strong><span>en pausa</span></div>
            <div><strong>{preview.futureSessions}</strong><span>{preview.futureSessions === 1 ? 'cita futura' : 'citas futuras'}</span></div>
            {!isReassign && <div><strong>{preview.pendingAppointmentRequests}</strong><span>{preview.pendingAppointmentRequests === 1 ? 'solicitud de cita' : 'solicitudes de cita'}</span></div>}
          </div>

          {!isReassign && (
            <ul className="mr-effects">
              <li>Pierde el acceso al momento y se cierran sus sesiones abiertas.</li>
              {preview.pendingAppointmentRequests > 0 && <li>Sus solicitudes de cita pendientes se rechazan y se apaga su reserva desde el portal.</li>}
              <li>Su QR de alta deja de funcionar. Sus solicitudes de alta pendientes quedan para titular y administración.</li>
            </ul>
          )}

          {pending ? (
            <fieldset className="xa-fieldset">
              <legend>{isReassign ? `¿A quién pasas ${pendingSummary(preview)}?` : `¿Qué hacemos con ${pendingSummary(preview)}?`}</legend>
              {preview.reassignTargets.length === 0 ? (
                <p className="xa-help">No hay otro profesional activo que atienda pacientes. {isReassign ? 'Invita o marca a alguien en el equipo y vuelve aquí.' : 'Quedarán pendientes hasta que lo decidas.'}</p>
              ) : (
                <div className="xa-options">
                  <label className={`xa-option${destination === 'reassign' ? ' is-selected' : ''}`}>
                    <input type="radio" name={`${id}-dest`} checked={destination === 'reassign'} onChange={() => setDestination('reassign')} />
                    <span>
                      Pasarlos a otro profesional
                      <small>Sus procesos abiertos y sus citas futuras pasan a la persona que elijas.</small>
                    </span>
                  </label>
                  {destination === 'reassign' && (
                    <label className="field mr-select">
                      Profesional
                      <select value={toUserId} onChange={(event) => { setToUserId(event.target.value); setError(''); }}>
                        {preview.reassignTargets.map((t) => <option key={t.userId} value={t.userId}>{targetName(t)}</option>)}
                      </select>
                    </label>
                  )}
                  {!isReassign && (
                    <label className={`xa-option${destination === 'later' ? ' is-selected' : ''}`}>
                      <input type="radio" name={`${id}-dest`} checked={destination === 'later'} onChange={() => setDestination('later')} />
                      <span>
                        Decidir después
                        <small>Quedan a su nombre, sin que nadie acceda a su contenido, hasta que los pases desde Equipo.</small>
                      </span>
                    </label>
                  )}
                </div>
              )}
              <p className="mr-notes" role="note">
                Sus notas internas no pasan a nadie: se conservan con su autoría y el nuevo profesional solo verá que existen.
              </p>
            </fieldset>
          ) : (
            <p className="ps-dialog-text">{isReassign ? 'Ya no tiene nada pendiente a su nombre.' : 'No tiene procesos abiertos ni citas futuras: no hay nada que pasar a otra persona.'}</p>
          )}

          {!isReassign && (
            <fieldset className="xa-fieldset">
              <legend>Motivo <span className="xa-required">(opcional)</span></legend>
              <div className="mr-reasons">
                {REMOVAL_REASONS.map((value) => (
                  <label key={value} className={`xa-option${reason === value ? ' is-selected' : ''}`}>
                    <input type="radio" name={`${id}-reason`} checked={reason === value} onChange={() => setReason(value)} />
                    <span>{REMOVAL_REASON_LABEL[value]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <p className="mr-keep">
            No se borra nada: su historial y lo que escribió siguen en la consulta con su nombre.
            {!isReassign && preview.role === 'THERAPIST' && <> Si necesita una copia de lo suyo, haz antes la <Link href="/settings/data">exportación</Link>.</>}
          </p>

          {error && <p ref={errorRef} className="agenda-error reason-dialog-error" role="alert">{error}</p>}

          <div className="agenda-modal-actions">
            <button type="button" className="agenda-cancel-button" disabled={busy} onClick={() => dialogRef.current?.close()}>Cancelar</button>
            {isReassign ? (
              <button type="submit" className="button" disabled={busy || !pending || !toUserId}>{busy ? 'Pasando…' : chosenName ? `Pasar a ${chosenName}` : 'Pasar'}</button>
            ) : (
              <button type="submit" className="button danger" disabled={busy}>{busy ? 'Dando de baja…' : `Dar de baja a ${target.name}`}</button>
            )}
          </div>
        </form>
      )}
    </dialog>
  );
}
