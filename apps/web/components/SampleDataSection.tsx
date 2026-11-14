'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ClearSampleDataResultContract, SampleDataStatusContract, SamplePortalAccessContract } from '@asepsico/contracts';
import QrCode from '@/components/QrCode';
import type { Viewer } from '@/lib/clinical';
import {
  canManageSampleData,
  clearErrorMessage,
  clearResultMessage,
  clearSampleData,
  loadSampleDataStatus,
  portalAccessErrorMessage,
  PORTAL_LOGIN_PATH,
  requestSamplePortalAccess,
  SAMPLE_DATA_SECTION_ID,
  SAMPLE_NOTICE_CLINICIAN,
  SAMPLE_NOTICE_NO_REAL_DATA,
  SAMPLE_NOTICE_TITLE,
  SAMPLE_PORTAL_PATIENT_NOT_FOUND,
  sampleStatusSummary,
} from '@/lib/sample-data';
import { ApiError } from '@/lib/api';

/* ------------------------------------------------------------------------------------------------
 * Credenciales del paciente de prueba (se muestran UNA vez). Solo props: nada se guarda fuera.
 * ---------------------------------------------------------------------------------------------- */

type CredentialsProps = {
  access: SamplePortalAccessContract;
  /** Enlace absoluto al acceso del portal (para el QR). Nunca lleva la contraseña. */
  portalUrl: string;
  copyStatus: string;
  onCopy: (field: 'email' | 'password') => void;
  onHide: () => void;
};

export function SamplePortalCredentials({ access, portalUrl, copyStatus, onCopy, onHide }: CredentialsProps) {
  return (
    <div className="sample-credentials" role="group" aria-labelledby="sample-credentials-title">
      <h3 id="sample-credentials-title">Acceso de {access.firstName} {access.lastName} (paciente de prueba)</h3>
      <p className="e1-notice danger sample-credentials-warning" role="note">
        <span><strong>Guárdala ahora: no se volverá a mostrar.</strong> Si la pierdes, genera otra; la anterior dejará de valer.</span>
      </p>
      <dl className="sample-credentials-list">
        <div>
          <dt>Email</dt>
          <dd><code>{access.email}</code></dd>
          <dd><button type="button" className="button secondary" onClick={() => onCopy('email')}>Copiar email<span className="sr-only"> del paciente de prueba</span></button></dd>
        </div>
        <div>
          <dt>Contraseña temporal</dt>
          <dd><code className="sample-credentials-secret">{access.temporaryPassword}</code></dd>
          <dd><button type="button" className="button secondary" onClick={() => onCopy('password')}>Copiar contraseña</button></dd>
        </div>
      </dl>
      <small className="muted" role="status" aria-live="polite">{copyStatus}</small>
      <p className="muted">El portal te pedirá cambiarla al entrar. Ábrelo en tu móvil para verlo como lo verá tu paciente.</p>
      <div className="sample-credentials-portal">
        {portalUrl && <QrCode value={portalUrl} label="Código QR para abrir el acceso al portal del paciente en el móvil" size={152} className="sample-credentials-qr" />}
        <div>
          <a className="button" href={PORTAL_LOGIN_PATH} target="_blank" rel="noopener noreferrer">
            Abrir el portal del paciente<span className="sr-only"> (se abre en otra pestaña)</span>
          </a>
          <p className="muted">O escanea el código con el móvil. El código solo lleva el enlace del portal, no la contraseña.</p>
        </div>
      </div>
      <button type="button" className="bk-link-button" onClick={onHide}>Ya la he guardado, ocultar</button>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Diálogo de confirmación del borrado.
 * ---------------------------------------------------------------------------------------------- */

type ClearDialogProps = {
  open: boolean;
  samplePatients: number;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
};

/**
 * <dialog> nativo con showModal(): foco atrapado, Escape para cerrar (salvo mientras borra). El foco
 * empieza en «Cancelar» (la opción segura) y vuelve al botón que lo abrió al cerrar.
 */
export function ClearSampleDataDialog({ open, samplePatients, busy, error, onConfirm, onClose }: ClearDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const id = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
      requestAnimationFrame(() => cancelRef.current?.focus());
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

  const patientsText = samplePatients === 1 ? 'el paciente de ejemplo' : `los ${samplePatients} pacientes de ejemplo`;

  return (
    <dialog
      ref={dialogRef}
      className="agenda-modal reason-dialog sample-clear-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-desc`}
      onClose={handleClosed}
      onCancel={(event) => { if (busy) event.preventDefault(); }}
    >
      {open && (
        <div>
          <div className="agenda-modal-header">
            <div><h2 id={`${id}-title`}>¿Borrar los datos de ejemplo?</h2></div>
            <button type="button" aria-label="Cerrar" disabled={busy} onClick={() => dialogRef.current?.close()}>×</button>
          </div>
          <div id={`${id}-desc`} className="sample-clear-desc">
            <p>Se borrarán {patientsText} con sus citas, procesos, notas y tareas, y el acceso al portal del paciente de prueba.</p>
            <p><strong>No se puede deshacer.</strong></p>
            <p>Los pacientes que hayas creado tú no se tocan.</p>
          </div>
          {error && <p className="agenda-error reason-dialog-error" role="alert">{error}</p>}
          <div className="agenda-modal-actions">
            <button ref={cancelRef} type="button" className="agenda-cancel-button" disabled={busy} onClick={() => dialogRef.current?.close()}>Cancelar</button>
            <button type="button" className="button danger" disabled={busy} onClick={onConfirm}>
              {busy ? 'Borrando…' : 'Sí, borrar los datos de ejemplo'}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Sección «Datos de ejemplo» (ajustes). Solo OWNER; no aparece si no se cargaron datos de ejemplo.
 * ---------------------------------------------------------------------------------------------- */

type LoadState = 'loading' | 'ready' | 'hidden' | 'error';

export default function SampleDataSection({ viewer }: { viewer: Viewer | null }) {
  const role = viewer?.role ?? null;
  const owner = canManageSampleData(role);
  const [state, setState] = useState<LoadState>('loading');
  const [status, setStatus] = useState<SampleDataStatusContract | null>(null);

  // Credenciales: SOLO estado local de este componente. Se borran al ocultarlas, al salir de la
  // pantalla (desmontaje) y si el navegador descarta la página (pagehide, p. ej. caché atrás/adelante).
  const [access, setAccess] = useState<SamplePortalAccessContract | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessError, setAccessError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [origin, setOrigin] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState('');
  const [clearResult, setClearResult] = useState<ClearSampleDataResultContract | null>(null);
  // Tras borrar, el botón que abrió el diálogo desaparece: el foco va al resultado.
  const resultRef = useRef<HTMLParagraphElement>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const value = await loadSampleDataStatus(role);
      setStatus(value);
      setState(value?.loaded ? 'ready' : 'hidden');
    } catch {
      setState('error');
    }
  }, [role]);

  useEffect(() => { if (owner) void load(); }, [owner, load]);

  useEffect(() => {
    setOrigin(window.location.origin);
    const forget = () => { setAccess(null); setCopyStatus(''); };
    window.addEventListener('pagehide', forget);
    return () => {
      window.removeEventListener('pagehide', forget);
      forget();
    };
  }, []);

  if (!owner || state === 'hidden') return null;

  async function showPortalAccess() {
    setAccessBusy(true); setAccessError(''); setCopyStatus(''); setAccess(null);
    try {
      setAccess(await requestSamplePortalAccess());
    } catch (err) {
      setAccessError(portalAccessErrorMessage(err));
      if (err instanceof ApiError && err.code === SAMPLE_PORTAL_PATIENT_NOT_FOUND) {
        setStatus((current) => (current ? { ...current, portalPatient: null } : current));
      }
    } finally {
      setAccessBusy(false);
    }
  }

  async function copy(field: 'email' | 'password') {
    if (!access) return;
    try {
      await navigator.clipboard.writeText(field === 'email' ? access.email : access.temporaryPassword);
      setCopyStatus(field === 'email' ? 'Email copiado.' : 'Contraseña copiada.');
    } catch {
      setCopyStatus('No se ha podido copiar. Selecciónalo y cópialo a mano.');
    }
  }

  async function confirmClear() {
    setClearBusy(true); setClearError('');
    try {
      const result = await clearSampleData();
      setClearResult(result);
      setAccess(null);
      setStatus((current) => current ? { ...current, clearedAt: result.clearedAt, samplePatients: 0, portalPatient: null } : current);
      setDialogOpen(false);
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (err) {
      setClearError(clearErrorMessage(err));
    } finally {
      setClearBusy(false);
    }
  }

  return (
    <section id={SAMPLE_DATA_SECTION_ID} className="patient-card sample-data-section" aria-labelledby="sample-data-title">
      <h2 id="sample-data-title">Datos de ejemplo</h2>

      {state === 'loading' && <p className="muted" role="status">Cargando los datos de ejemplo…</p>}

      {state === 'error' && (
        <div role="alert">
          <p>No hemos podido cargar el estado de los datos de ejemplo.</p>
          <button type="button" className="button secondary" onClick={() => void load()}>Intentar de nuevo</button>
        </div>
      )}

      {state === 'ready' && status && (
        <>
          {!status.clearedAt && (
            <p className="e1-notice info" role="note">
              {/* [LEX/CLIO] texto pendiente de validar */}
              <span><strong>{SAMPLE_NOTICE_TITLE}</strong> {SAMPLE_NOTICE_NO_REAL_DATA} {SAMPLE_NOTICE_CLINICIAN}</span>
            </p>
          )}
          <p className="sample-data-summary">{sampleStatusSummary(status)}</p>
          <p ref={resultRef} tabIndex={-1} className={clearResult ? 'patient-save-state' : 'bk-live'} role="status" aria-live="polite">{clearResult ? clearResultMessage(clearResult) : ''}</p>

          {!status.clearedAt && (
            <>
              <div className="sample-data-block">
                <h3>Ver el portal como paciente</h3>
                {status.portalPatient ? (
                  <>
                    <p className="muted">
                      Genera una contraseña temporal para entrar en el portal como {status.portalPatient.firstName} {status.portalPatient.lastName}, paciente inventado.
                      Cada vez que la generes, la anterior dejará de valer.
                    </p>
                    {!access && (
                      <button type="button" className="button" disabled={accessBusy} onClick={() => void showPortalAccess()}>
                        {accessBusy ? 'Generando acceso…' : 'Ver el portal como paciente'}
                      </button>
                    )}
                  </>
                ) : (
                  <p className="muted">Ya no hay ningún paciente de prueba con acceso al portal.</p>
                )}
                {accessError && <p className="agenda-error" role="alert">{accessError}</p>}
                {access && (
                  <SamplePortalCredentials
                    access={access}
                    portalUrl={origin ? `${origin}${PORTAL_LOGIN_PATH}` : ''}
                    copyStatus={copyStatus}
                    onCopy={(field) => void copy(field)}
                    onHide={() => { setAccess(null); setCopyStatus(''); }}
                  />
                )}
              </div>

              <div className="sample-data-block ps-danger-zone">
                <h3>Empezar de cero</h3>
                <p className="muted">Borra solo los pacientes inventados y todo lo suyo. Lo que hayas creado tú se queda.</p>
                <button type="button" className="button danger" onClick={() => { setClearError(''); setDialogOpen(true); }}>
                  Borrar los datos de ejemplo
                </button>
              </div>
            </>
          )}

          {status.clearedAt && (
            <p className="muted">Tu espacio ya no tiene pacientes inventados. Puedes seguir en <Link href="/patients">Pacientes</Link>.</p>
          )}

          <ClearSampleDataDialog
            open={dialogOpen}
            samplePatients={status.samplePatients}
            busy={clearBusy}
            error={clearError}
            onConfirm={() => void confirmClear()}
            onClose={() => { if (!clearBusy) setDialogOpen(false); }}
          />
        </>
      )}
    </section>
  );
}
