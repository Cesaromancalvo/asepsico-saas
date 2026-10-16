'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LegalDocumentType, RegisterMemberRequestContract } from '@asepsico/contracts';
import InviteOnlyCard from '@/components/InviteOnlyCard';
import TermsChecklist, { missingTermsMessage } from '@/components/TermsChecklist';
import { api, ApiError } from '@/lib/api';
import { invalidateViewer, ROLE_LABEL, StaffRole } from '@/lib/clinical';
import { fetchLegalTerms, invalidateTermsStatus, LegalDocument, registrationErrorMessage, toAcceptedTerm, useInviteToken } from '@/lib/legal';

type PrivacyNotice = { documentType: string; version: string; title: string; textHash: string; draft: boolean; text: string };
type JoinResponse = { role: StaffRole; privacyNotice: PrivacyNotice | null };

/** Alta de un miembro invitado por la persona titular. Rol y "atiende pacientes" los fija la invitación. */
export default function JoinPage() {
  const router = useRouter();
  const invite = useInviteToken();
  // Los miembros invitados también aceptan las condiciones vigentes (no solo la persona titular).
  const [docs, setDocs] = useState<LegalDocument[]>([]);
  const [termsState, setTermsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [showTermsErrors, setShowTermsErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<JoinResponse | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  const loadTerms = useCallback(async () => {
    setTermsState('loading');
    try {
      const current = await fetchLegalTerms();
      // Sin documentos vigentes no hay nada que aceptar y la API rechazaría el alta.
      if (current.length === 0) throw new Error('sin condiciones');
      setDocs(current);
      setChecked({});
      setShowTermsErrors(false);
      setTermsState('ready');
    } catch {
      setTermsState('error');
    }
  }, []);

  useEffect(() => {
    if (invite.ready && invite.token) loadTerms();
  }, [invite.ready, invite.token, loadTerms]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function setDocChecked(documentType: LegalDocumentType, value: boolean) {
    setChecked((current) => ({ ...current, [documentType]: value }));
  }

  useEffect(() => {
    if (joined) doneRef.current?.focus();
  }, [joined]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!invite.token) return;
    setError('');
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get('password') ?? '');
    const passwordField = form.elements.namedItem('password');
    if (password.length < 12) {
      setError('La contraseña debe tener al menos 12 caracteres.');
      return;
    }
    const missingTerms = missingTermsMessage(docs, checked);
    if (missingTerms) {
      setShowTermsErrors(true);
      setError(missingTerms);
      return;
    }
    const body: RegisterMemberRequestContract = {
      firstName: String(data.get('firstName') ?? '').trim(),
      lastName: String(data.get('lastName') ?? '').trim(),
      email: String(data.get('email') ?? '').trim(),
      password,
      inviteToken: invite.token,
      // Tal cual llegaron de GET /legal/terms: la API comprueba versión y hash.
      acceptedTerms: docs.map(toAcceptedTerm),
    };
    setBusy(true);
    try {
      const result = await api<JoinResponse>('/auth/register/member', { method: 'POST', body: JSON.stringify(body) });
      if (passwordField instanceof HTMLInputElement) passwordField.value = '';
      invalidateViewer();
      invalidateTermsStatus();
      setJoined({ role: result.role, privacyNotice: result.privacyNotice ?? null });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.code === 'TERMS_NOT_ACCEPTED') {
        await loadTerms();
        setError('Las condiciones se han actualizado mientras rellenabas el formulario. Revísalas y vuelve a aceptarlas.');
      } else {
        setError(registrationErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function continueToApp() {
    // Titular, administración y terapeutas necesitan la verificación en dos pasos antes de empezar.
    router.push(joined?.role === 'ASSISTANT' ? '/' : '/settings/security');
  }

  if (!invite.ready) {
    return (
      <main className="shell">
        <div className="card auth-card"><p className="muted" role="status">Cargando…</p></div>
      </main>
    );
  }

  if (joined) {
    const notice = joined.privacyNotice;
    return (
      <main className="shell">
        <div className="card auth-card">
          <div className="brand"><span className="brand-mark" aria-hidden="true">A</span>AsePsico</div>
          <h1 tabIndex={-1} ref={doneRef}>Ya formas parte del equipo</h1>
          <p className="muted">
            Te has unido como {ROLE_LABEL[joined.role] ?? joined.role}.
            {joined.role !== 'ASSISTANT' && ' Antes de empezar tendrás que activar la verificación en dos pasos.'}
          </p>
          {notice && (
            <section aria-labelledby="privacy-notice-title" className="e1-stack" style={{ margin: '18px 0' }}>
              <div>
                <h2 id="privacy-notice-title" style={{ marginBottom: 4 }}>{notice.title}</h2>
                <small className="muted">
                  Versión {notice.version}. Es la política que has aceptado al crear tu cuenta; puedes volver a
                  leerla cuando quieras en <Link href="/legal">la página de condiciones</Link>.
                </small>
              </div>
              {notice.draft && (
                <div className="e1-notice" role="note">
                  <div>
                    <strong>Texto pendiente de completar</strong>
                    <p>Este documento aún tiene datos por completar, así que todavía no es la versión definitiva.</p>
                  </div>
                </div>
              )}
              <pre className="legal-text" tabIndex={0} aria-label={`Texto de ${notice.title}`}>{notice.text}</pre>
            </section>
          )}
          <button type="button" className="button" onClick={continueToApp}>Continuar</button>
        </div>
      </main>
    );
  }

  if (!invite.token) return <InviteOnlyCard />;

  return (
    <main className="shell">
      <div className="card auth-card">
        <div className="brand"><span className="brand-mark" aria-hidden="true">A</span>AsePsico</div>
        <h1>Únete a tu consulta</h1>
        <p className="muted">
          Te han invitado a formar parte del equipo de una consulta en AsePsico. Usa el mismo correo al que te llegó la
          invitación; tu rol ya viene indicado en ella.
        </p>
        <p className="muted">
          Cada persona del equipo acepta las condiciones por sí misma. Antes de crear tu cuenta, lee las condiciones de
          uso del piloto demo y la política de privacidad, y marca sus casillas.
        </p>
        <form onSubmit={submit}>
          <label className="field">Nombre<input name="firstName" autoComplete="given-name" required minLength={2} maxLength={100} /></label>
          <label className="field">Apellidos<input name="lastName" autoComplete="family-name" required minLength={2} maxLength={100} /></label>
          <label className="field">Correo<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
          <label className="field">
            Contraseña
            <input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={200} aria-describedby="join-password-hint" />
            <small id="join-password-hint" className="muted">Mínimo 12 caracteres.</small>
          </label>
          {termsState === 'loading' && <p className="muted" role="status">Cargando las condiciones…</p>}
          {termsState === 'error' && (
            <div className="e1-notice danger" role="alert">
              <div>
                <strong>No se han podido cargar las condiciones</strong>
                <p>Sin ellas no se puede completar el alta. Comprueba tu conexión y vuelve a intentarlo.</p>
              </div>
              <div className="e1-notice-actions">
                <button type="button" className="button secondary" onClick={loadTerms}>Reintentar</button>
              </div>
            </div>
          )}
          {termsState === 'ready' && (
            <TermsChecklist docs={docs} checked={checked} onChange={setDocChecked} disabled={busy} idPrefix="join-terms" showErrors={showTermsErrors} />
          )}
          {error && <p className="error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
          <button className="button" type="submit" disabled={busy || termsState !== 'ready'}>{busy ? 'Creando cuenta…' : 'Crear mi cuenta'}</button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>¿Ya tienes cuenta? <Link href="/login">Inicia sesión</Link></p>
      </div>
    </main>
  );
}
