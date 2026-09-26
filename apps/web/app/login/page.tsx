'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

type LoginResponse =
  | { mfaRequired: true; pendingToken: string }
  | { mfaRequired: false; user: { id: string; email: string; firstName: string; lastName: string }; workspaceId: string; role: string };

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(''); // aviso al volver al paso 1 porque el paso 2 ya no vale
  const [pendingToken, setPendingToken] = useState<string>(''); // vacío = todavía en el paso 1 (email/contraseña)
  const [busy, setBusy] = useState(false);

  function backToPasswordStep(message = '') {
    setPendingToken('');
    setError('');
    setNotice(message);
  }

  async function submitPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    const form = e.currentTarget;
    const data = new FormData(form);
    const passwordField = form.elements.namedItem('password');
    if (passwordField instanceof HTMLInputElement) passwordField.value = '';
    try {
      const result = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: data.get('email'), password: data.get('password') }),
      });
      if (result.mfaRequired) {
        setPendingToken(result.pendingToken);
      } else {
        router.push('/patients');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión');
    } finally {
      setBusy(false);
    }
  }

  async function submitMfaCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const form = e.currentTarget;
    const code = new FormData(form).get('code');
    const codeField = form.elements.namedItem('code');
    if (codeField instanceof HTMLInputElement) codeField.value = '';
    try {
      await api<LoginResponse>('/auth/login/mfa', {
        method: 'POST',
        body: JSON.stringify({ pendingToken, code }),
      });
      router.push('/patients');
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Código no válido';
      if (err instanceof ApiError && err.status === 401 && message !== 'Código no válido') {
        // pendingToken anulado por intentos fallidos, caducado o no válido: hay que empezar de nuevo.
        backToPasswordStep(message);
        return;
      }
      // 401 "Código no válido" o 429 "Demasiados intentos fallidos. Espera N minutos…": texto de la API tal cual.
      setError(message);
      if (codeField instanceof HTMLInputElement) codeField.focus();
    } finally {
      setBusy(false);
    }
  }

  if (pendingToken) {
    return (
      <main className="shell">
        <div className="card" style={{ maxWidth: 460, margin: '80px auto' }}>
          <div className="brand">AsePsico</div>
          <h1>Verificación en dos pasos</h1>
          <p className="muted">Introduce el código de 6 dígitos de tu app de autenticación, o uno de tus códigos de recuperación.</p>
          <form onSubmit={submitMfaCode}>
            <label className="field">
              Código
              <input name="code" autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required minLength={6} maxLength={11} />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="button" type="submit" disabled={busy}>{busy ? 'Comprobando…' : 'Confirmar'}</button>
          </form>
          <button
            type="button"
            className="button secondary"
            style={{ marginTop: 12 }}
            onClick={() => backToPasswordStep()}
          >
            Volver a introducir el correo y la contraseña
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="card" style={{ maxWidth: 460, margin: '80px auto' }}>
        <div className="brand">AsePsico</div>
        <h1>Accede a tu consulta</h1>
        <p className="muted">Demo: demo@asepsico.es / AsePsico2026!</p>
        {notice && <p className="error" role="alert">{notice}</p>}
        <form onSubmit={submitPassword}>
          <label className="field">Correo<input name="email" type="email" autoComplete="username" defaultValue="demo@asepsico.es" required /></label>
          <label className="field">Contraseña<input name="password" type="password" autoComplete="current-password" defaultValue="AsePsico2026!" autoFocus={!!notice} required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button" type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        </form>
      </div>
    </main>
  );
}
