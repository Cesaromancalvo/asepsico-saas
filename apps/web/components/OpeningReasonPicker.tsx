'use client';

import { FormEvent, ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  OPENING_REASON_INTRO,
  PROCESS_OPENING_REASONS,
  PROCESS_OPENING_REASON_LABELS,
  type ProcessOpeningReasonCode,
} from '@/lib/exceptional-access';

type FieldsetProps = {
  value: ProcessOpeningReasonCode | '';
  onChange: (value: ProcessOpeningReasonCode) => void;
  /** Mensaje de error ligado al grupo (aria-describedby). */
  error?: string;
  disabled?: boolean;
  /** Para enfocar el grupo cuando la API pide el motivo. */
  firstOptionRef?: React.Ref<HTMLInputElement>;
};

/**
 * Selector del motivo de apertura (H6, §3.8): catálogo cerrado de 4, sin texto libre ni "Otro".
 * Grupo de radios nativo: se recorre con flechas y se anuncia como un único grupo.
 */
export function OpeningReasonFieldset({ value, onChange, error, disabled, firstOptionRef }: FieldsetProps) {
  const id = useId();
  const introId = `${id}-intro`;
  const errorId = `${id}-error`;
  return (
    <fieldset className="xa-fieldset" aria-describedby={`${introId}${error ? ` ${errorId}` : ''}`} disabled={disabled}>
      <legend>Motivo de apertura</legend>
      <p id={introId} className="xa-help">{OPENING_REASON_INTRO}</p>
      <div className="xa-options">
        {PROCESS_OPENING_REASONS.map((code, index) => (
          <label key={code} className={`xa-option${value === code ? ' is-selected' : ''}`}>
            <input
              ref={index === 0 ? firstOptionRef : undefined}
              type="radio"
              name={`${id}-opening-reason`}
              value={code}
              checked={value === code}
              onChange={() => onChange(code)}
              aria-invalid={error && !value ? true : undefined}
            />
            <span>{PROCESS_OPENING_REASON_LABELS[code]}</span>
          </label>
        ))}
      </div>
      {error && <p id={errorId} className="xa-field-error" role="alert">{error}</p>}
    </fieldset>
  );
}

type DialogProps = {
  open: boolean;
  /** "Reactivar proceso", "Reabrir proceso"… */
  confirmLabel: string;
  onResolve: (value: ProcessOpeningReasonCode | null) => void;
};

/** Diálogo modal con el selector (reactivar desde un botón, sin formulario alrededor). */
export function OpeningReasonDialog({ open, confirmLabel, onResolve }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const resolvedRef = useRef(false);
  const [value, setValue] = useState<ProcessOpeningReasonCode | ''>('');
  const [error, setError] = useState('');
  const id = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      resolvedRef.current = false;
      setValue('');
      setError('');
      dialog.showModal();
      requestAnimationFrame(() => firstRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function finish(result: ProcessOpeningReasonCode | null) {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    onResolve(result);
    dialogRef.current?.close();
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target && document.contains(target)) target.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!value) {
      setError('Elige el motivo de apertura.');
      firstRef.current?.focus();
      return;
    }
    finish(value);
  }

  return (
    <dialog ref={dialogRef} className="agenda-modal reason-dialog xa-dialog-small" aria-labelledby={`${id}-title`} onClose={() => finish(null)}>
      {open && (
        <form onSubmit={submit} noValidate>
          <div className="agenda-modal-header">
            <h2 id={`${id}-title`}>Motivo de apertura</h2>
            <button type="button" aria-label="Cerrar" onClick={() => finish(null)}>×</button>
          </div>
          <OpeningReasonFieldset value={value} onChange={(next) => { setValue(next); setError(''); }} error={error} firstOptionRef={firstRef} />
          <div className="agenda-modal-actions">
            <button type="button" className="agenda-cancel-button" onClick={() => finish(null)}>Cancelar</button>
            <button type="submit" className="button">{confirmLabel}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/**
 * Pregunta el motivo de apertura cuando la API lo pide. Uso:
 *   const { ask, dialog } = useOpeningReasonPrompt('Reactivar proceso');
 *   await withOpeningReason((code) => changeProcessStatus(id, 'ACTIVE', code), ask);
 *   … y pintar {dialog} en la pantalla.
 */
export function useOpeningReasonPrompt(confirmLabel = 'Continuar'): { ask: () => Promise<ProcessOpeningReasonCode | null>; dialog: ReactNode } {
  const [pending, setPending] = useState<((value: ProcessOpeningReasonCode | null) => void) | null>(null);
  const ask = useCallback(() => new Promise<ProcessOpeningReasonCode | null>((resolve) => setPending(() => resolve)), []);
  const dialog = (
    <OpeningReasonDialog
      open={pending !== null}
      confirmLabel={confirmLabel}
      onResolve={(value) => {
        pending?.(value);
        setPending(null);
      }}
    />
  );
  return { ask, dialog };
}
