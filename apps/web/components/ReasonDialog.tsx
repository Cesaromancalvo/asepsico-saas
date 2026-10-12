'use client';

import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { CLINICAL_TEXT_HINT } from '@/lib/billing';

/** Máximo del DTO de la API (VoidInvoiceDto / ReversePaymentDto: @MaxLength(500)). */
export const REASON_MAX_LENGTH = 500;

type Props = {
  open: boolean;
  title: string;
  /** Texto breve bajo el título: qué se va a hacer y sobre qué (p. ej. el número del cobro). */
  description?: string;
  label: string;
  confirmLabel: string;
  /** Devuelve un mensaje de error para mostrarlo dentro del diálogo, o null si ha ido bien. */
  onConfirm: (reason: string) => Promise<string | null>;
  onClose: () => void;
};

/**
 * Diálogo modal para pedir un motivo administrativo (anular un cobro, revertir un pago).
 * Usa <dialog> nativo con showModal(): foco atrapado, Escape para cerrar y rol de diálogo modal
 * para lectores de pantalla. Al cerrar, el foco vuelve al botón que lo abrió.
 */
export default function ReasonDialog({ open, title, description, label, confirmLabel, onConfirm, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  const errorId = `${id}-error`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      setReason(''); setError(''); setBusy(false);
      dialog.showModal();
      // showModal() enfoca el primer control (la ×); el foco va al campo del motivo.
      requestAnimationFrame(() => textareaRef.current?.focus());
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
    const trimmed = reason.trim();
    if (!trimmed) { setError('Indica el motivo.'); return; }
    setBusy(true); setError('');
    const failure = await onConfirm(trimmed.slice(0, REASON_MAX_LENGTH));
    setBusy(false);
    if (failure) setError(failure);
    else dialogRef.current?.close();
  }

  const remaining = REASON_MAX_LENGTH - reason.length;
  const nearLimit = remaining <= 50;

  return <dialog
    ref={dialogRef}
    className="agenda-modal reason-dialog"
    aria-labelledby={titleId}
    aria-describedby={description ? descId : undefined}
    onClose={handleClosed}
    onCancel={(event) => { if (busy) event.preventDefault(); }}
  >
    {open && <form onSubmit={submit} noValidate>
      <div className="agenda-modal-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descId} className="reason-dialog-desc">{description}</p>}
        </div>
        <button type="button" aria-label="Cerrar" disabled={busy} onClick={() => dialogRef.current?.close()}>×</button>
      </div>
      <label className="field reason-dialog-field">
        <span>{label}</span>
        <textarea
          ref={textareaRef}
          rows={4}
          required
          maxLength={REASON_MAX_LENGTH}
          value={reason}
          onChange={(event) => { setReason(event.target.value); if (error) setError(''); }}
          aria-describedby={`${hintId} ${countId}${error ? ` ${errorId}` : ''}`}
          aria-invalid={error ? true : undefined}
        />
      </label>
      <div className="reason-dialog-meta">
        <small id={hintId} className="demo-hint">{CLINICAL_TEXT_HINT}</small>
        <small id={countId} className={nearLimit ? 'reason-dialog-count is-near' : 'reason-dialog-count'} aria-live={nearLimit ? 'polite' : 'off'}>
          {reason.length}/{REASON_MAX_LENGTH} caracteres
        </small>
      </div>
      {error && <p id={errorId} className="agenda-error reason-dialog-error" role="alert">{error}</p>}
      <div className="agenda-modal-actions">
        <button type="button" className="agenda-cancel-button" disabled={busy} onClick={() => dialogRef.current?.close()}>Cancelar</button>
        <button type="submit" className="button primary" disabled={busy || !reason.trim()}>{busy ? 'Guardando…' : confirmLabel}</button>
      </div>
    </form>}
  </dialog>;
}
