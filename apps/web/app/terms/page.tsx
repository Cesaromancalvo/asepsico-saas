'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LegalDocumentType } from '@asepsico/contracts';
import TermsChecklist from '@/components/TermsChecklist';
import { api, ApiError, logout } from '@/lib/api';
import { invalidateViewer } from '@/lib/clinical';
import { fetchLegalTerms, fetchTermsStatus, invalidateTermsStatus, LegalDocument, TermsStatus, toAcceptedTerm } from '@/lib/legal';

type State = 'loading' | 'ready' | 'error';

/**
 * "Nuevas condiciones". Llega aquí cualquier pantalla que reciba el 428 TERMS_ACCEPTANCE_REQUIRED
 * (interceptor de lib/api.ts). Solo la persona titular (OWNER) puede aceptarlas; el resto ve un aviso.
 */
export default function TermsPage() {
  const router = useRouter();
  const [state, setState] = useState<State>('loading');
  const [status, setStatus] = useState<TermsStatus | null>(null);
  const [current, setCurrent] = useState<LegalDocument[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
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
    if (pending.some((doc) => checked[doc.documentType] !== true)) {
      setError('Para continuar tienes que aceptar todos los documentos.');
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
      } else if (err instanceof ApiError && err.status === 503 && err.code === 'LEGAL_TERMS_DRAFT') {
        setError('Las condiciones aún no están disponibles. Inténtalo más adelante.');
      } else if (err instanceof ApiError && err.status === 403) {
        setError('Solo la persona titular de la consulta puede aceptar las condiciones.');
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
            <p>Tu consulta tiene aceptadas las condiciones vigentes. No tienes que hacer nada.</p>
            <button type="button" className="button" onClick={() => router.push('/')}>Ir a Mi jornada</button>
          </>
        )}

        {state === 'ready' && status?.acceptanceRequired && !status.canAccept && (
          <>
            <div className="e1-notice" role="note">
              <div>
                <strong>Tu consulta tiene que aceptar las nuevas condiciones</strong>
                <p>Avisa a la persona titular: solo ella puede aceptarlas. Mientras tanto puedes seguir trabajando.</p>
              </div>
            </div>
            <button type="button" className="button" onClick={() => router.push('/')}>Volver</button>
          </>
        )}

        {state === 'ready' && status?.acceptanceRequired && status.canAccept && (
          <>
            <p className="muted">
              Hemos actualizado las condiciones del servicio. Como titular de la consulta, revísalas y acéptalas para
              seguir usando AsePsico. Mientras no las aceptes, el acceso queda en pausa para ti.
            </p>
            <TermsChecklist
              docs={pending}
              checked={checked}
              onChange={(documentType: LegalDocumentType, value: boolean) => setChecked((c) => ({ ...c, [documentType]: value }))}
              disabled={busy}
              idPrefix="new-terms"
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
