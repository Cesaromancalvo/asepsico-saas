'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { activatePortalAccount, PublicRequestError, tokenFromHash } from '@/lib/portal-signup';

type Step = 'loading' | 'no-token' | 'form' | 'done';

const INVALID_LINK = 'Este enlace ya no es válido. Pide otro a tu consulta.';

/** Misma política que el cambio de contraseña: 12 a 128 caracteres con mayúscula, minúscula y número. */
function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'La contraseña debe tener al menos 12 caracteres.';
  if (password.length > 128) return 'La contraseña no puede pasar de 128 caracteres.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) return 'La contraseña debe incluir una mayúscula, una minúscula y un número.';
  return null;
}

/**
 * Activación de la cuenta del portal: el paciente elige su contraseña con el enlace que su
 * consulta le ha dado en persona. Un solo uso; caducado, usado o revocado → el mismo mensaje.
 */
export default function PortalActivationPage() {
  const id = useId();
  const [step, setStep] = useState<Step>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState(false);
  const doneRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const value = tokenFromHash(window.location.hash);
    setToken(value);
    setStep(value ? 'form' : 'no-token');
  }, []);

  useEffect(() => { if (step === 'done') doneRef.current?.focus(); }, [step]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get('password') ?? '');
    const repeat = String(data.get('repeat') ?? '');
    setError('');
    const problem = passwordProblem(password);
    if (problem) { setError(problem); return; }
    if (password !== repeat) { setError('Las dos contraseñas no coinciden.'); return; }
    setBusy(true);
    try {
      await activatePortalAccount({ token, password });
      form.reset();
      setStep('done');
      window.history.replaceState(null, '', window.location.pathname);
    } catch (err) {
      if (err instanceof PublicRequestError && err.code === 'PORTAL_ACTIVATION_INVALID') {
        setInvalid(true);
        window.history.replaceState(null, '', window.location.pathname);
      } else {
        setError(err instanceof Error && err.message ? err.message : 'No se ha podido activar. Vuelve a intentarlo.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="portal-login ps-public">
      <section aria-labelledby={`${id}-title`}>
        <span className="eyebrow">Portal de pacientes</span>

        {step === 'loading' && <p role="status">Cargando…</p>}

        {(step === 'no-token' || invalid) && (
          <>
            <h1 id={`${id}-title`}>{invalid ? 'Enlace no válido' : 'Este enlace no está completo'}</h1>
            <p>{invalid ? INVALID_LINK : 'Vuelve a escanear el código que te muestra tu consulta.'}</p>
          </>
        )}

        {step === 'done' && (
          <div className="ps-result">
            <h1 id={`${id}-title`} ref={doneRef} tabIndex={-1}>Tu cuenta está activa</h1>
            <p>Ya puedes entrar en tu portal con tu correo y la contraseña que acabas de elegir.</p>
            <Link className="button primary ps-block" href="/portal/login">Entrar en el portal</Link>
          </div>
        )}

        {step === 'form' && !invalid && (
          <>
            <h1 id={`${id}-title`}>Elige tu contraseña</h1>
            <p>Solo tú la conocerás. Te servirá para entrar en tu portal con tu correo.</p>
            <form onSubmit={submit}>
              <label>
                Contraseña nueva
                <input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} aria-describedby={`${id}-rule`} />
                <small id={`${id}-rule`}>Al menos 12 caracteres, con una mayúscula, una minúscula y un número.</small>
              </label>
              <label>Repite la contraseña<input name="repeat" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
              {error && <div className="agenda-error" role="alert">{error}</div>}
              <button className="button primary" type="submit" disabled={busy}>{busy ? 'Activando…' : 'Activar mi cuenta'}</button>
            </form>
            <small>El portal no es un canal de urgencias. Si es una urgencia, llama al 112. Si tienes pensamientos de suicidio, llama al 024.</small>
          </>
        )}
      </section>
    </main>
  );
}
