'use client';

import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import type { JustificationReadPurpose, ReadJustificationResponse } from '@asepsico/contracts';
import { api } from '@/lib/api';
import { READ_PURPOSE_LABEL, readPurposesFor } from '@/lib/exceptional-access';

type Props = {
  /** Acceso cuya explicación se quiere leer, o null si el diálogo está cerrado. */
  access: { id: string; blocked: boolean; summary: string } | null;
  onClose: () => void;
};

/**
 * [Ver explicación] (CA4.2, CA4.6): primero se elige el motivo de lectura (queda auditado) y solo
 * entonces se descifra y se muestra aquí, nunca en el listado. Paciente bloqueado: solo motivos
 * de bloqueo. Al cerrar, el texto se descarta.
 */
export default function JustificationDialog({ access, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [purpose, setPurpose] = useState<JustificationReadPurpose | ''>('');
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const open = access !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      setPurpose(''); setText(null); setError(''); setBusy(false);
      dialog.showModal();
      requestAnimationFrame(() => firstRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function handleClosed() {
    setText(null);
    onClose();
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target && document.contains(target)) target.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!access) return;
    if (!purpose) { setError('Elige para qué necesitas leerla.'); firstRef.current?.focus(); return; }
    setBusy(true); setError('');
    try {
      const result = await api<ReadJustificationResponse>(`/exceptional-access/${access.id}/justification`, { method: 'POST', body: JSON.stringify({ purpose }) });
      setText(result.justification ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo leer la explicación');
    } finally { setBusy(false); }
  }

  const purposes = readPurposesFor(access?.blocked ?? false);
  return (
    <dialog ref={dialogRef} className="agenda-modal reason-dialog xa-dialog-small" aria-labelledby={`${id}-title`} aria-describedby={`${id}-desc`} onClose={handleClosed}>
      {open && (
        <div>
          <div className="agenda-modal-header">
            <div>
              <h2 id={`${id}-title`}>Explicación del acceso</h2>
              <p id={`${id}-desc`} className="reason-dialog-desc">{access.summary}</p>
            </div>
            <button type="button" aria-label="Cerrar" onClick={() => dialogRef.current?.close()}>×</button>
          </div>
          {text === null ? (
            <form onSubmit={submit} noValidate>
              <fieldset className="xa-fieldset" disabled={busy}>
                <legend>¿Para qué necesitas leerla?</legend>
                <p className="xa-help">La lectura queda registrada con el motivo que elijas.{access.blocked ? ' El paciente está bloqueado: solo se puede leer por una reclamación, una autoridad o una petición del propio paciente.' : ''}</p>
                <div className="xa-options">
                  {purposes.map((code, index) => (
                    <label key={code} className={`xa-option${purpose === code ? ' is-selected' : ''}`}>
                      <input ref={index === 0 ? firstRef : undefined} type="radio" name={`${id}-purpose`} value={code} checked={purpose === code} onChange={() => { setPurpose(code); setError(''); }} />
                      <span>{READ_PURPOSE_LABEL[code]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {error && <p className="agenda-error reason-dialog-error" role="alert">{error}</p>}
              <div className="agenda-modal-actions">
                <button type="button" className="agenda-cancel-button" disabled={busy} onClick={() => dialogRef.current?.close()}>Cancelar</button>
                <button type="submit" className="button" disabled={busy}>{busy ? 'Abriendo…' : 'Ver explicación'}</button>
              </div>
            </form>
          ) : (
            <div>
              <p className="xa-justification" tabIndex={-1}>{text || 'Este acceso no tiene explicación guardada.'}</p>
              <div className="agenda-modal-actions">
                <button type="button" className="button" autoFocus onClick={() => dialogRef.current?.close()}>Cerrar</button>
              </div>
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
