'use client';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invalidateViewer } from '@/lib/clinical';
import { api, ApiError } from '@/lib/api';
import { sanitizeOtp } from '@/lib/otp';

type LoginResponse =
  | { mfaRequired: true; pendingToken: string }
  | { mfaRequired: false; user: { id: string; email: string; firstName: string; lastName: string }; workspaceId: string; role: string };

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(''); // aviso al volver al paso 1 porque el paso 2 ya no vale
  const [pendingToken, setPendingToken] = useState<string>(''); // vacío = todavía en el paso 1 (email/contraseña)
  const [busy, setBusy] = useState(false);
  // Correo del paso 1: se reusa como usuario oculto en el paso 2 para los gestores de contraseñas.
  const [email, setEmail] = useState('');
  // Campo del código controlado y vacío al entrar, para que el navegador no lo rellene con el correo guardado.
  const [code, setCode] = useState('');
  const otpRef = useRef<HTMLInputElement>(null);

  // Defensa ante el autorrelleno de Safari, que puede escribir el correo en el campo del código sin pasar por React
  // o un instante después de montar el paso 2: se revisa al montar y poco después.
  useEffect(() => {
    if (!pendingToken) return;
    const clearIfEmail = () => {
      const field = otpRef.current;
      if (field && field.value !== sanitizeOtp(field.value)) {
        field.value = '';
        setCode('');
      }
    };
    clearIfEmail();
    const timers = [100, 500, 1500].map((ms) => window.setTimeout(clearIfEmail, ms));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [pendingToken]);

  function backToPasswordStep(message = '') {
    setPendingToken('');
    setCode('');
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
    const enteredEmail = String(data.get('email') ?? '');
    setEmail(enteredEmail);
    const passwordField = form.elements.namedItem('password');
    if (passwordField instanceof HTMLInputElement) passwordField.value = '';
    try {
      const result = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: enteredEmail, password: data.get('password') }),
      });
      if (result.mfaRequired) {
        setCode('');
        setPendingToken(result.pendingToken);
      } else {
        invalidateViewer();
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
    const codeField = form.elements.namedItem('otp');
    setCode('');
    try {
      await api<LoginResponse>('/auth/login/mfa', {
        method: 'POST',
        body: JSON.stringify({ pendingToken, code }),
      });
      invalidateViewer();
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
          <div className="brand"><span className="brand-mark" aria-hidden="true">A</span>AsePsico</div>
          <h1>Verificación en dos pasos</h1>
          <p className="muted">Introduce el código de 6 dígitos de tu app de autenticación, o uno de tus códigos de recuperación.</p>
          <form onSubmit={submitMfaCode}>
            {/*
              Usuario oculto antes del código: Safari y los gestores de contraseñas meten aquí el correo en vez de en
              el campo del código. Oculto solo a la vista (no con hidden ni display:none, que Safari ignora al autorrellenar).
            */}
            <input
              id="mfa-username"
              className="sr-only autofill-username"
              type="email"
              name="username"
              autoComplete="username"
              value={email}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
            />
            <label className="field">
              Código
              <input
                ref={otpRef}
                id="otp"
                name="otp"
                type="text"
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                required
                minLength={6}
                maxLength={11}
                value={code}
                onChange={(event) => setCode(sanitizeOtp(event.target.value))}
                onFocus={(event) => {
                  if (event.target.value !== sanitizeOtp(event.target.value)) setCode('');
                }}
              />
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
        <div className="brand"><span className="brand-mark" aria-hidden="true">A</span>AsePsico</div>
        <h1>Accede a tu consulta</h1>
        {notice && <p className="error" role="alert">{notice}</p>}
        <form onSubmit={submitPassword}>
          <label className="field">Correo<input name="email" type="email" autoComplete="username" required /></label>
          <label className="field">Contraseña<input name="password" type="password" autoComplete="current-password" autoFocus={!!notice} required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button" type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>
          ¿Todavía no tienes cuenta? El alta es solo por invitación: abre el enlace completo que te enviaron.
        </p>
      </div>
    </main>
  );
}
