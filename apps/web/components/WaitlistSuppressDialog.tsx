'use client';

import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon';

type Props = {
  /** Alta a suprimir (null = cerrado). `label` es lo que se enseña para reconocerla (nombre o fecha). */
  target: { id: string; label: string; detail: string } | null;
  /** Devuelve un mensaje de error para mostrarlo dentro del diálogo, o null si se ha suprimido. */
  onConfirm: (id: string, password: string) => Promise<string | null>;
  onClose: () => void;
};

/**
 * Confirmación de "Suprimir alta" del panel de la lista de espera. Pide la contraseña del
 * PLATFORM_ADMIN y explica que no se puede deshacer. <dialog> nativo con showModal(): foco
 * atrapado, Escape para cerrar (salvo mientras se envía) y foco de vuelta al botón que lo abrió.
 * La contraseña solo vive en el estado de este componente y se borra al cerrar.
 */
export default function WaitlistSuppressDialog({ target, onConfirm, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const errorId = `${id}-error`;
  const open = target !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      setPassword(''); setError(''); setBusy(false);
      dialog.showModal();
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function handleClosed() {
    setPassword('');
    onClose();
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    if (back && document.contains(back)) back.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    if (!password) { setError('Escribe tu contraseña para confirmar.'); inputRef.current?.focus(); return; }
    setBusy(true); setError('');
    const failure = await onConfirm(target.id, password);
    setBusy(false);
    if (failure) {
      setError(failure);
      setPassword('');
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      dialogRef.current?.close();
    }
  }

  return <dialog
    ref={dialogRef}
    className="agenda-modal wl-dialog"
    aria-labelledby={titleId}
    aria-describedby={descId}
    onClose={handleClosed}
    onCancel={(event) => { if (busy) event.preventDefault(); }}
  >
    {target && <form onSubmit={submit} noValidate>
      <div className="agenda-modal-header">
        <div>
          <p className="eyebrow">Lista de espera</p>
          <h2 id={titleId}>Suprimir esta alta</h2>
        </div>
        <button type="button" aria-label="Cerrar" disabled={busy} onClick={() => dialogRef.current?.close()}>×</button>
      </div>

      <div className="wl-dialog-target">
        <strong>{target.label}</strong>
        <small>{target.detail}</small>
      </div>

      <div id={descId} className="wl-dialog-warning">
        <Icon name="info" size={18} />
        <div>
          <p><strong>Vas a suprimir los datos de esta persona de la lista de espera. No se puede deshacer.</strong></p>
          <p>Se borran su nombre, su email y sus respuestas. Solo queda un registro sin datos personales para contar altas y bajas. Si vuelve a apuntarse, entrará como un alta nueva.</p>
        </div>
      </div>

      <label className="field wl-dialog-field">
        <span>Tu contraseña de AsePsico</span>
        <input
          ref={inputRef}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          maxLength={200}
          value={password}
          disabled={busy}
          onChange={(event) => { setPassword(event.target.value); if (error) setError(''); }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </label>
      <small className="wl-dialog-hint">Los intentos con contraseña incorrecta cuentan para el bloqueo temporal de tu cuenta.</small>
      {error && <p id={errorId} className="agenda-error wl-dialog-error" role="alert">{error}</p>}

      <div className="agenda-modal-actions">
        <button type="button" className="agenda-cancel-button" disabled={busy} onClick={() => dialogRef.current?.close()}>Cancelar</button>
        <button type="submit" className="button danger" disabled={busy || !password}>{busy ? 'Suprimiendo…' : 'Suprimir definitivamente'}</button>
      </div>
    </form>}
  </dialog>;
}
