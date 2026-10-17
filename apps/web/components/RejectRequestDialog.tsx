'use client';

import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { REJECTION_REASONS, RejectionReason } from '@asepsico/contracts';
import { REJECTION_REASON_LABEL } from '@/lib/booking';

type Props = {
  open: boolean;
  /** Devuelve un mensaje de error para enseñarlo dentro del diálogo, o null si ha ido bien. */
  onConfirm: (reason: RejectionReason) => Promise<string | null>;
  onClose: () => void;
};

/**
 * Rechazar una solicitud de cita. El motivo es de lista cerrada (sin texto libre) y lo ve el
 * paciente, así que no se puede escribir nada clínico. <dialog> nativo: foco atrapado, Escape
 * cierra y el foco vuelve al botón que lo abrió.
 */
export default function RejectRequestDialog({ open, onConfirm, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [reason, setReason] = useState<RejectionReason | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      setReason(''); setError(''); setBusy(false);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function handleClosed() {
    onClose();
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target && document.contains(target)) target.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason) { setError('Elige un motivo.'); return; }
    setBusy(true); setError('');
    const failure = await onConfirm(reason);
    setBusy(false);
    if (failure) setError(failure);
    else dialogRef.current?.close();
  }

  return (
    <dialog
      ref={dialogRef}
      className="agenda-modal reason-dialog"
      aria-labelledby={`${id}-title`}
      onClose={handleClosed}
      onCancel={(event) => { if (busy) event.preventDefault(); }}
    >
      {open && (
        <form onSubmit={submit} noValidate>
          <div className="agenda-modal-header">
            <div>
              <h2 id={`${id}-title`}>Rechazar la solicitud</h2>
              <p className="reason-dialog-desc">El paciente verá este motivo en su portal. No se puede añadir texto.</p>
            </div>
            <button type="button" aria-label="Cerrar" disabled={busy} onClick={() => dialogRef.current?.close()}>×</button>
          </div>
          <fieldset className="bk-radio-group" aria-describedby={error ? `${id}-error` : undefined}>
            <legend>Motivo</legend>
            {REJECTION_REASONS.map((value) => (
              <label key={value} className="bk-radio">
                <input type="radio" name={`${id}-reason`} value={value} checked={reason === value} onChange={() => { setReason(value); setError(''); }} />
                <span>{REJECTION_REASON_LABEL[value]}</span>
              </label>
            ))}
          </fieldset>
          {error && <p id={`${id}-error`} className="agenda-error reason-dialog-error" role="alert">{error}</p>}
          <div className="agenda-modal-actions">
            <button type="button" className="agenda-cancel-button" disabled={busy} onClick={() => dialogRef.current?.close()}>Cancelar</button>
            <button type="submit" className="button primary" disabled={busy || !reason}>{busy ? 'Guardando…' : 'Rechazar solicitud'}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
