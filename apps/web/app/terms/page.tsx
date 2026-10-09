'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LegalDocumentType } from '@asepsico/contracts';
import TermsChecklist, { missingTermsMessage } from '@/components/TermsChecklist';
import { api, ApiError, logout } from '@/lib/api';
import { invalidateViewer } from '@/lib/clinical';
import { fetchLegalTerms, fetchTermsStatus, invalidateTermsStatus, isLegalTermsDraftError, LEGAL_TERMS_DRAFT_MESSAGE, LegalDocument, TermsStatus, toAcceptedTerm } from '@/lib/legal';

type State = 'loading' | 'ready' | 'error';

/**
 * "Nuevas condiciones". Llega aquí cualquier pantalla que reciba el 428 TERMS_ACCEPTANCE_REQUIRED
 * (interceptor de lib/api.ts). Cada profesional (titular o miembro del equipo) las acepta por sí mismo:
 * la API devuelve canAccept=true para cualquier miembro. Si aun así llegara canAccept=false, se
 * muestra un aviso neutro en lugar del formulario.
 */
export default function TermsPage() {
  const router = useRouter();
  const [state, setState] = useState<State>('loading');
  const [status, setStatus] = useState<TermsStatus | null>(null);
  const [current, setCurrent] = useState<LegalDocument[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [showTermsErrors, setShowTermsErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError('');
    try {
      const [nextStatus, docs] = await Promise.all([fetchTermsStatus(true), fetchLegalTerms()]);
      if (!nextStatus) throw new Error('sin estado');
      setStatus(nextStatus);
      setCurrent(docs);
      setChecked({});
      setShowTermsErrors(false);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // Pendientes con el título y la marca de borrador de la versión vigente.
  const pending = (status?.pending ?? []).map((ref) => current.find((doc) => doc.documentType === ref.documentType) ?? { ...ref, text: '' });

  async function accept() {
    setError('');
    const missingTerms = missingTermsMessage(pending, checked);
    if (missingTerms) {
      setShowTermsErrors(true);
      setError(missingTerms);
      return;
    }
    setBusy(true);
    try {
      // La API exige todas las versiones vigentes (las ya aceptadas no cambian) tal cual llegaron.
      await api<TermsStatus>('/legal/terms/accept', { method: 'POST', body: JSON.stringify({ acceptedTerms: current.map(toAcceptedTerm) }) });
      invalidateTermsStatus();
      invalidateViewer();
      router.push('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.code === 'TERMS_NOT_ACCEPTED') {
        await load();
        setError('Las condiciones se han actualizado mientras las revisabas. Vuelve a revisarlas y aceptarlas.');
      } else if (isLegalTermsDraftError(err)) {
        setError(LEGAL_TERMS_DRAFT_MESSAGE);
      } else if (err instanceof ApiError && err.status === 403) {
        setError('No se ha podido guardar tu aceptación. Puede que tu cuenta ya no forme parte de esta consulta: cierra sesión y vuelve a entrar.');
      } else {
        setError(err instanceof Error && err.message ? err.message : 'No se han podido aceptar las condiciones.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await logout();
      invalidateViewer();
      invalidateTermsStatus();
    } finally {
      window.location.href = '/login';
    }
  }

  return (
    <main className="shell">
      <div className="card auth-card">
        <div className="brand">AsePsico</div>
        <h1>Nuevas condiciones</h1>

        {state === 'loading' && <p className="muted" role="status">Comprobando las condiciones…</p>}

        {state === 'error' && (
          <div role="alert">
            <p>No se ha podido comprobar el estado de las condiciones. Puede que tu sesión haya caducado.</p>
            <div className="e1-actions">
              <button type="button" className="button secondary" onClick={load}>Reintentar</button>
              <a className="button secondary" href="/login">Iniciar sesión</a>
            </div>
          </div>
        )}

        {state === 'ready' && status && !status.acceptanceRequired && (
          <>
            <p>Ya tienes aceptadas las condiciones vigentes. No tienes que hacer nada.</p>
            <button type="button" className="button" onClick={() => router.push('/')}>Ir a Mi jornada</button>
          </>
        )}

        {state === 'ready' && status?.acceptanceRequired && !status.canAccept && (
          <>
            <div className="e1-notice" role="note">
              <div>
                <strong>No se pueden aceptar las condiciones desde esta cuenta</strong>
                <p>Cierra sesión y vuelve a entrar. Si sigue apareciendo este aviso, escríbenos por email.</p>
              </div>
            </div>
            <button type="button" className="button" onClick={handleLogout}>Cerrar sesión</button>
          </>
        )}

        {state === 'ready' && status?.acceptanceRequired && status.canAccept && (
          <>
            <p className="muted">
              Hay condiciones nuevas o actualizadas. Cada persona del equipo las acepta por sí misma: revísalas y
              acéptalas para seguir usando AsePsico. Mientras no lo hagas, tu acceso queda en pausa; el del resto del
              equipo no cambia.
            </p>
            <TermsChecklist
              docs={pending}
              checked={checked}
              onChange={(documentType: LegalDocumentType, value: boolean) => setChecked((c) => ({ ...c, [documentType]: value }))}
              disabled={busy}
              idPrefix="new-terms"
              showErrors={showTermsErrors}
            />
            {error && <p className="error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
            <div className="e1-actions">
              <button type="button" className="button" onClick={accept} disabled={busy}>
                {busy ? 'Guardando…' : 'Aceptar y continuar'}
              </button>
              <button type="button" className="button secondary" onClick={handleLogout} disabled={busy}>Cerrar sesión</button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
