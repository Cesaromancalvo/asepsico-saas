'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LegalDocumentType, RegisterRequestContract } from '@asepsico/contracts';
import InviteOnlyCard from '@/components/InviteOnlyCard';
import TermsChecklist, { missingTermsMessage } from '@/components/TermsChecklist';
import { api, ApiError } from '@/lib/api';
import { invalidateViewer } from '@/lib/clinical';
import { fetchLegalTerms, invalidateTermsStatus, LegalDocument, registrationErrorMessage, toAcceptedTerm, useInviteToken } from '@/lib/legal';

export default function RegisterPage() {
  const router = useRouter();
  const invite = useInviteToken();
  const [docs, setDocs] = useState<LegalDocument[]>([]);
  const [termsState, setTermsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [showTermsErrors, setShowTermsErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

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
    const body: RegisterRequestContract = {
      firstName: String(data.get('firstName') ?? '').trim(),
      lastName: String(data.get('lastName') ?? '').trim(),
      email: String(data.get('email') ?? '').trim(),
      password,
      workspaceName: String(data.get('workspaceName') ?? '').trim(),
      // "¿Atiendes pacientes?": desmarcada por defecto. Quien solo gestiona la consulta no
      // necesita ser profesional clínico; se puede cambiar después en Equipo.
      isClinician: data.get('isClinician') === 'on',
      inviteToken: invite.token,
      // Tal cual llegaron de GET /legal/terms: la API comprueba versión y hash.
      acceptedTerms: docs.map(toAcceptedTerm),
    };
    setBusy(true);
    try {
      await api('/auth/register', { method: 'POST', body: JSON.stringify(body) });
      if (passwordField instanceof HTMLInputElement) passwordField.value = '';
      invalidateViewer();
      invalidateTermsStatus();
      // La persona titular necesita la verificación en dos pasos antes de usar la aplicación.
      router.push('/settings/security');
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.code === 'TERMS_NOT_ACCEPTED') {
        // Las condiciones han cambiado mientras rellenaba el formulario: se recargan.
        await loadTerms();
        setError('Las condiciones se han actualizado mientras rellenabas el formulario. Revísalas y vuelve a aceptarlas.');
      } else {
        setError(registrationErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!invite.ready) {
    return (
      <main className="shell">
        <div className="card auth-card"><p className="muted" role="status">Cargando…</p></div>
      </main>
    );
  }

  if (!invite.token) return <InviteOnlyCard />;

  return (
    <main className="shell">
      <div className="card auth-card">
        <div className="brand">AsePsico</div>
        <h1>Crea tu consulta</h1>
        <p className="muted">
          Crearás la cuenta de la persona titular de la consulta. Usa el mismo correo al que te llegó la invitación.
          Después podrás invitar al resto del equipo.
        </p>
        <form onSubmit={submit}>
          <label className="field">Nombre<input name="firstName" autoComplete="given-name" required minLength={2} maxLength={100} /></label>
          <label className="field">Apellidos<input name="lastName" autoComplete="family-name" required minLength={2} maxLength={100} /></label>
          <label className="field">Correo<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
          <label className="field">
            Contraseña
            <input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={200} aria-describedby="password-hint" />
            <small id="password-hint" className="muted">Mínimo 12 caracteres.</small>
          </label>
          <label className="field">Nombre de la consulta<input name="workspaceName" autoComplete="organization" required minLength={2} maxLength={150} /></label>
          <div className="e1-checkbox">
            <input id="isClinician" type="checkbox" name="isClinician" defaultChecked={false} aria-describedby="clinician-hint" />
            <span>
              <label htmlFor="isClinician">¿Atiendes pacientes?</label>
              <small id="clinician-hint">
                Márcala si además de gestionar la consulta vas a atender pacientes. Si no, solo verás los datos
                administrativos. Puedes cambiarlo más adelante en Equipo.
              </small>
            </span>
          </div>

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
            <TermsChecklist docs={docs} checked={checked} onChange={setDocChecked} disabled={busy} idPrefix="register-terms" showErrors={showTermsErrors} />
          )}

          {error && <p className="error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
          <button className="button" type="submit" disabled={busy || termsState !== 'ready'}>
            {busy ? 'Creando cuenta…' : 'Crear cuenta'}
          </button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>¿Ya tienes cuenta? <Link href="/login">Inicia sesión</Link></p>
      </div>
    </main>
  );
}
