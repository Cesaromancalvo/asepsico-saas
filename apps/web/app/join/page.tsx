'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RegisterMemberRequestContract } from '@asepsico/contracts';
import InviteOnlyCard from '@/components/InviteOnlyCard';
import { api } from '@/lib/api';
import { invalidateViewer, ROLE_LABEL, StaffRole } from '@/lib/clinical';
import { invalidateTermsStatus, registrationErrorMessage, useInviteToken } from '@/lib/legal';

type PrivacyNotice = { documentType: string; version: string; title: string; textHash: string; draft: boolean; text: string };
type JoinResponse = { role: StaffRole; privacyNotice: PrivacyNotice | null };

/** Alta de un miembro invitado por la persona titular. Rol y "atiende pacientes" los fija la invitación. */
export default function JoinPage() {
  const router = useRouter();
  const invite = useInviteToken();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<JoinResponse | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

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
    const body: RegisterMemberRequestContract = {
      firstName: String(data.get('firstName') ?? '').trim(),
      lastName: String(data.get('lastName') ?? '').trim(),
      email: String(data.get('email') ?? '').trim(),
      password,
      inviteToken: invite.token,
    };
    setBusy(true);
    try {
      const result = await api<JoinResponse>('/auth/register/member', { method: 'POST', body: JSON.stringify(body) });
      if (passwordField instanceof HTMLInputElement) passwordField.value = '';
      invalidateViewer();
      invalidateTermsStatus();
      setJoined({ role: result.role, privacyNotice: result.privacyNotice ?? null });
    } catch (err) {
      setError(registrationErrorMessage(err));
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
          <div className="brand">AsePsico</div>
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
                  Versión {notice.version}. Es información sobre cómo se tratan tus datos como profesional: no tienes
                  que aceptar nada.
                </small>
              </div>
              {notice.draft && (
                <div className="e1-notice" role="note">
                  <div>
                    <strong>Texto en borrador</strong>
                    <p>Este documento aún es un borrador sin validez legal; recibirás la versión definitiva.</p>
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
        <div className="brand">AsePsico</div>
        <h1>Únete a tu consulta</h1>
        <p className="muted">
          Te han invitado a formar parte del equipo de una consulta en AsePsico. Usa el mismo correo al que te llegó la
          invitación; tu rol ya viene indicado en ella.
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
          {error && <p className="error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
          <button className="button" type="submit" disabled={busy}>{busy ? 'Creando cuenta…' : 'Crear mi cuenta'}</button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>¿Ya tienes cuenta? <Link href="/login">Inicia sesión</Link></p>
      </div>
    </main>
  );
}
