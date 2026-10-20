'use client';

import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import type { PortalSignupAcceptedContract, PortalSignupLinkWarning } from '@asepsico/contracts';
import { api, ApiError } from '@/lib/api';
import { acceptLinkingPatient, formatDay, isLinkWarning, LINK_WARNING_LABEL, SignupRequest } from '@/lib/portal-signup';

type PatientOption = { id: string; firstName: string; lastName: string; birthDate?: string | null; status?: string };

type Props = {
  /** null = cerrado. */
  request: SignupRequest | null;
  onClose: () => void;
  onLinked: (result: PortalSignupAcceptedContract, request: SignupRequest, patient: PatientOption) => void;
};

/** Errores de la API al vincular con un texto pensado para recepción. */
function linkErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'PORTAL_SIGNUP_IDENTITY_MISMATCH') {
      return 'El nombre, los apellidos o la fecha de nacimiento no coinciden con la ficha. Revísalos con el paciente o crea un paciente nuevo.';
    }
    if (err.code === 'PORTAL_ACCOUNT_ALREADY_EXISTS') {
      return 'Este paciente ya tiene cuenta en el portal (o una pendiente de activar). Rechaza esta solicitud.';
    }
    if (err.code === 'PORTAL_SIGNUP_MANUAL_WITH_GUARDIAN') {
      return 'Este paciente no admite alta por QR: activa su portal a mano, con su madre, padre o tutor, desde su ficha.';
    }
    if (err.status === 404) return 'No encontramos esa solicitud o ese paciente. Puede que ya se haya resuelto: recarga la bandeja.';
    if (err.message) return err.message;
  }
  return 'No se ha podido vincular. Vuelve a intentarlo.';
}

const sameDay = (a?: string | null, b?: string | null) => Boolean(a && b && a.slice(0, 10) === b.slice(0, 10));

/**
 * Vincular una solicitud de alta a un paciente que ya existe. Si la API detecta diferencias con
 * la ficha (correo, teléfono) o un portal desactivado antes, responde 409
 * PORTAL_SIGNUP_CONFIRMATION_REQUIRED: se explica qué no cuadra y solo se reenvía con
 * confirmWarnings cuando quien atiende confirma que ha comprobado la identidad en persona.
 */
export default function LinkPatientDialog({ request, onClose, onLinked }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const warningsRef = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientOption[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<PatientOption | null>(null);
  const [warnings, setWarnings] = useState<PortalSignupLinkWarning[]>([]);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (request && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      setQuery(request.lastName); setResults(null); setSelected(null); setWarnings([]); setVerified(false); setError(''); setBusy(false);
      dialog.showModal();
      requestAnimationFrame(() => searchRef.current?.focus());
      void search(request.lastName);
    } else if (!request && dialog.open) {
      dialog.close();
    }
    // search solo depende de la solicitud abierta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    if (warnings.length) warningsRef.current?.focus();
  }, [warnings]);

  function handleClosed() {
    onClose();
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target && document.contains(target)) target.focus();
  }

  async function search(text: string) {
    const q = text.trim();
    if (q.length < 2) { setResults([]); return; }
    setSearching(true); setError('');
    try {
      const page = await api<{ data: PatientOption[] }>(`/patients?q=${encodeURIComponent(q)}&pageSize=10`);
      setResults(page.data);
    } catch (err) {
      setResults([]);
      setError(err instanceof Error && err.message ? err.message : 'No se ha podido buscar.');
    } finally {
      setSearching(false);
    }
  }

  function onSearch(event: FormEvent) {
    event.preventDefault();
    setSelected(null); setWarnings([]); setVerified(false);
    void search(query);
  }

  async function link(confirm: boolean) {
    if (!request || !selected) return;
    setBusy(true); setError('');
    try {
      const result = await acceptLinkingPatient(request.id, selected.id, confirm ? warnings : undefined);
      onLinked(result, request, selected);
      dialogRef.current?.close();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'PORTAL_SIGNUP_CONFIRMATION_REQUIRED') {
        const list = Array.isArray(err.body.warnings) ? err.body.warnings.filter(isLinkWarning) : [];
        setWarnings(list); setVerified(false);
        if (!list.length) setError(linkErrorMessage(err));
      } else {
        setError(linkErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const requestName = request ? `${request.firstName} ${request.lastName}` : '';

  return (
    <dialog
      ref={dialogRef}
      className="agenda-modal ps-dialog"
      aria-labelledby={`${id}-title`}
      onClose={handleClosed}
      onCancel={(event) => { if (busy) event.preventDefault(); }}
    >
      {request && (
        <>
          <div className="agenda-modal-header">
            <div>
              <p className="ps-dialog-kicker">Solicitud de {requestName}</p>
              <h2 id={`${id}-title`}>Vincular a su ficha</h2>
            </div>
            <button type="button" aria-label="Cerrar" disabled={busy} onClick={() => dialogRef.current?.close()}>×</button>
          </div>

          {warnings.length === 0 ? (
            <>
              <p className="ps-dialog-text">
                Busca al paciente. Para vincularlo, su nombre, apellidos y fecha de nacimiento ({formatDay(request.birthDate)}) deben coincidir con la ficha.
              </p>
              <form className="ps-search" onSubmit={onSearch} role="search">
                <label className="ps-label" htmlFor={`${id}-q`}>Nombre, apellidos, correo o teléfono</label>
                <div className="ps-search-row">
                  <input id={`${id}-q`} ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} maxLength={120} autoComplete="off" />
                  <button type="submit" className="button secondary" disabled={searching || busy}>{searching ? 'Buscando…' : 'Buscar'}</button>
                </div>
              </form>

              <div aria-live="polite" aria-busy={searching}>
                {results && results.length === 0 && !searching && (
                  <p className="ps-empty">No hay pacientes con esa búsqueda. Si es nuevo, cierra y usa «Crear paciente».</p>
                )}
                {results && results.length > 0 && (
                  <fieldset className="xa-fieldset">
                    <legend>Elige el paciente</legend>
                    <div className="xa-options">
                      {results.map((patient) => {
                        const match = sameDay(patient.birthDate, request.birthDate);
                        return (
                          <label key={patient.id} className={`xa-option${selected?.id === patient.id ? ' is-selected' : ''}`}>
                            <input type="radio" name={`${id}-patient`} checked={selected?.id === patient.id} onChange={() => { setSelected(patient); setError(''); }} />
                            <span>
                              {patient.firstName} {patient.lastName}
                              <small>
                                {patient.birthDate ? `Nació el ${formatDay(patient.birthDate)}` : 'Sin fecha de nacimiento en la ficha'}
                                {match ? ' · Coincide la fecha' : ''}
                              </small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                )}
              </div>
            </>
          ) : (
            <div className="ps-confirm" role="group" aria-labelledby={`${id}-warn-title`}>
              <h3 id={`${id}-warn-title`} ref={warningsRef} tabIndex={-1}>Comprueba su identidad antes de seguir</h3>
              <p>Hay diferencias entre la solicitud y la ficha de {selected?.firstName} {selected?.lastName}:</p>
              <ul className="ps-warning-list">
                {warnings.map((warning) => <li key={warning}>{LINK_WARNING_LABEL[warning]}</li>)}
              </ul>
              <p>
                Puede ser un cambio legítimo, pero también alguien que se hace pasar por el paciente. Pídele un documento de identidad
                y confirma con él los datos antes de darle acceso.
              </p>
              <label className="e1-checkbox">
                <input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} />
                <span>He comprobado en persona que es el paciente.</span>
              </label>
            </div>
          )}

          {error && <p className="agenda-error reason-dialog-error" role="alert">{error}</p>}

          <div className="agenda-modal-actions">
            {warnings.length > 0 ? (
              <>
                <button type="button" className="agenda-cancel-button" disabled={busy} onClick={() => { setWarnings([]); setVerified(false); }}>Volver</button>
                <button type="button" className="button" disabled={busy || !verified} onClick={() => void link(true)}>{busy ? 'Vinculando…' : 'Confirmar y vincular'}</button>
              </>
            ) : (
              <>
                <button type="button" className="agenda-cancel-button" disabled={busy} onClick={() => dialogRef.current?.close()}>Cancelar</button>
                <button type="button" className="button" disabled={busy || !selected} onClick={() => void link(false)}>{busy ? 'Vinculando…' : 'Vincular'}</button>
              </>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
