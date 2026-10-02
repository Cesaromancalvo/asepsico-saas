'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { invalidateViewer } from '@/lib/clinical';

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get('password') ?? '');
    const passwordField = form.elements.namedItem('password');
    if (password.length < 12) {
      setError('La contraseña debe tener al menos 12 caracteres.');
      if (passwordField instanceof HTMLInputElement) passwordField.focus();
      return;
    }
    setBusy(true);
    try {
      await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          firstName: String(data.get('firstName') ?? '').trim(),
          lastName: String(data.get('lastName') ?? '').trim(),
          email: String(data.get('email') ?? '').trim(),
          password,
          workspaceName: String(data.get('workspaceName') ?? '').trim(),
          // "¿Atiendes pacientes?": desmarcada por defecto. Quien solo gestiona la consulta no
          // necesita ser profesional clínico; se puede cambiar después en Equipo.
          isClinician: data.get('isClinician') === 'on',
        }),
      });
      if (passwordField instanceof HTMLInputElement) passwordField.value = '';
      invalidateViewer();
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la cuenta');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <div className="card" style={{ maxWidth: 520, margin: '60px auto' }}>
        <div className="brand">AsePsico</div>
        <h1>Crea tu consulta</h1>
        <p className="muted">Crearás la cuenta de la persona titular de la consulta. Después podrás invitar al resto del equipo.</p>
        <form onSubmit={submit} noValidate={false}>
          <label className="field">Nombre<input name="firstName" autoComplete="given-name" required minLength={2} /></label>
          <label className="field">Apellidos<input name="lastName" autoComplete="family-name" required minLength={2} /></label>
          <label className="field">Correo<input name="email" type="email" autoComplete="email" required /></label>
          <label className="field">
            Contraseña
            <input name="password" type="password" autoComplete="new-password" required minLength={12} aria-describedby="password-hint" />
            <small id="password-hint" className="muted">Mínimo 12 caracteres.</small>
          </label>
          <label className="field">Nombre de la consulta<input name="workspaceName" autoComplete="organization" required minLength={2} /></label>
          <label className="e1-checkbox">
            <input type="checkbox" name="isClinician" defaultChecked={false} aria-describedby="clinician-hint" />
            <span>
              ¿Atiendes pacientes?
              <small id="clinician-hint">
                Márcala si además de gestionar la consulta vas a atender pacientes. Si no, solo verás los datos
                administrativos. Puedes cambiarlo más adelante en Equipo.
              </small>
            </span>
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button" type="submit" disabled={busy}>{busy ? 'Creando cuenta…' : 'Crear cuenta'}</button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>¿Ya tienes cuenta? <Link href="/login">Inicia sesión</Link></p>
      </div>
    </main>
  );
}
