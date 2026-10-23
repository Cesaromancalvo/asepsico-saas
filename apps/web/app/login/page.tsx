'use client';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invalidateViewer } from '@/lib/clinical';
import { api, ApiError } from '@/lib/api';
import { OTP_AUTOFILL_CHECKS_MS, acceptOtpInput, isUserInsertion } from '@/lib/otp';

type LoginResponse =
  | { mfaRequired: true; pendingToken: string }
  | { mfaRequired: false; user: { id: string; email: string; firstName: string; lastName: string }; workspaceId: string; role: string };

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(''); // aviso al volver al paso 1 porque el paso 2 ya no vale
  const [pendingToken, setPendingToken] = useState<string>(''); // vacío = todavía en el paso 1 (email/contraseña)
  const [busy, setBusy] = useState(false);
  // Aviso al llegar desde una sesión revocada (lib/api.ts → /login?sesion=terminada).
  const [sessionEnded, setSessionEnded] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('sesion') !== 'terminada') return;
    setSessionEnded(true);
    // Se limpia la URL para que el aviso no vuelva a salir al recargar.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  // Campo del código controlado y vacío al entrar: el navegador no debe rellenarlo con el correo ni la contraseña.
  const [code, setCode] = useState('');
  const otpRef = useRef<HTMLInputElement>(null);
  // Si la persona ya ha tecleado, pegado o pulsado el campo. Safari autorrellena sin keydown ni beforeinput de usuario.
  const userInteracted = useRef(false);

  function markInteracted() {
    userInteracted.current = true;
  }

  // Al mostrar el paso 2 y durante unos segundos, se vacía cualquier valor que no venga de la persona
  // (Safari puede escribir en el DOM sin pasar por React, y hacerlo un instante después de montar).
  useEffect(() => {
    if (!pendingToken) return;
    userInteracted.current = false;
    const field = otpRef.current;
    const clearIfAutofilled = () => {
      const current = otpRef.current;
      if (!current) return;
      const accepted = acceptOtpInput(current.value, userInteracted.current);
      if (accepted !== current.value) {
        current.value = '';
        setCode('');
      }
    };
    const onBeforeInput = (event: Event) => {
      if (isUserInsertion((event as InputEvent).inputType)) markInteracted();
    };
    field?.addEventListener('beforeinput', onBeforeInput);
    clearIfAutofilled();
    const timers = OTP_AUTOFILL_CHECKS_MS.map((ms) => window.setTimeout(clearIfAutofilled, ms));
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      field?.removeEventListener('beforeinput', onBeforeInput);
    };
  }, [pendingToken]);

  function backToPasswordStep(message = '') {
    setPendingToken('');
    setCode('');
    userInteracted.current = false;
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
              Sin campo de usuario (ni oculto): con él Safari trata el paso como un login y mete el correo o la
              contraseña en el código. El código solo se acepta cuando la persona teclea, pega o pulsa el campo.
            */}
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
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                placeholder="123456"
                required
                minLength={6}
                maxLength={11}
                value={code}
                onKeyDown={markInteracted}
                onPaste={markInteracted}
                onPointerDown={markInteracted}
                onClick={markInteracted}
                onChange={(event) => {
                  const accepted = acceptOtpInput(event.target.value, userInteracted.current);
                  if (accepted !== event.target.value) event.target.value = '';
                  setCode(accepted);
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
        {sessionEnded && !notice && (
          <div className="e1-notice info" role="status">
            <div>
              <strong>Tu sesión ha terminado</strong>
              <p>Si acabas de cambiar tu contraseña o activar la verificación en dos pasos, vuelve a iniciar sesión. También puede que ya no formes parte de esta consulta: si no puedes entrar, habla con la persona titular.</p>
            </div>
          </div>
        )}
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
