'use client';
import { FormEvent, useRef, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api, ApiError, refreshSession } from '@/lib/api';

type SetupResponse = { qrCodeDataUrl: string; secret: string };
type ConfirmResponse = { recoveryCodes: string[] };

function messageOf(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Vacía un campo del formulario (contraseñas y códigos no se quedan escritos tras enviar). */
function clearField(form: HTMLFormElement, name: string) {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement) field.value = '';
}

export default function SecurityPage() {
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [disableError, setDisableError] = useState('');
  const [disableNotice, setDisableNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const confirmCodeRef = useRef<HTMLInputElement>(null);

  async function startSetup() {
    setError('');
    setConfirmError('');
    setBusy(true);
    try {
      const result = await api<SetupResponse>('/auth/mfa/setup', { method: 'POST' });
      setSetup(result);
    } catch (err) {
      // 400 si ya está activa: la API explica que hay que desactivarla primero.
      setError(messageOf(err, 'No se pudo iniciar la configuración'));
    } finally {
      setBusy(false);
    }
  }

  function cancelSetup() {
    setSetup(null);
    setConfirmError('');
  }

  async function confirmSetup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const password = data.get('password');
    const code = data.get('code');
    clearField(form, 'password');
    setConfirmError('');
    setBusy(true);
    try {
      const result = await api<ConfirmResponse>('/auth/mfa/confirm', {
        method: 'POST',
        body: JSON.stringify({ password, code }),
      });
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      // El access token lleva "mfaEnabled": se renueva para que el resto de la app se desbloquee ya.
      await refreshSession();
    } catch (err) {
      const message = messageOf(err, 'No se pudo activar la verificación en dos pasos');
      if (err instanceof ApiError && err.status === 400) {
        // Ya está activa (o la configuración ya no es válida): se vuelve a la tarjeta inicial con el aviso.
        setSetup(null);
        setError(message);
        return;
      }
      setConfirmError(message);
      if (err instanceof ApiError && err.status === 401) {
        if (message === 'Contraseña incorrecta') {
          confirmPasswordRef.current?.focus();
        } else {
          clearField(form, 'code');
          confirmCodeRef.current?.focus();
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function disableMfa(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const password = data.get('password');
    const code = data.get('code');
    clearField(form, 'password');
    setDisableError('');
    setDisableNotice('');
    setBusy(true);
    try {
      await api('/auth/mfa/disable', {
        method: 'POST',
        body: JSON.stringify({ password, code }),
      });
      form.reset();
      setDisableNotice('Verificación en dos pasos desactivada.');
      await refreshSession();
    } catch (err) {
      // 401 (contraseña o código), 429 (espera por intentos fallidos) o 400: el texto de la API tal cual.
      setDisableError(messageOf(err, 'No se pudo desactivar'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-layout">
      <Sidebar syncText="Seguridad de la cuenta" />
      <main className="patient-record-page">
        <header className="patient-record-header">
          <div>
            <span className="eyebrow">Seguridad</span>
            <h1>Verificación en dos pasos</h1>
            <p>Añade una capa extra a tu cuenta: además de la contraseña, un código de tu móvil.</p>
          </div>
        </header>

        {recoveryCodes ? (
          <section className="patient-card">
            <h2>Guarda estos códigos de recuperación</h2>
            <p>
              <strong>Solo se muestran una vez.</strong> Si algún día pierdes el móvil, cualquiera de estos 10
              códigos te deja entrar igualmente (cada uno solo sirve una vez). Guárdalos en un sitio seguro,
              no en este ordenador.
            </p>
            <div className="billing-list">
              {recoveryCodes.map((code) => (
                <code key={code} style={{ display: 'block', padding: '8px 12px', fontSize: '1.1em' }}>
                  {code}
                </code>
              ))}
            </div>
            <button className="button primary" style={{ marginTop: 16 }} onClick={() => setRecoveryCodes(null)}>
              Ya los he guardado
            </button>
          </section>
        ) : setup ? (
          <section className="patient-card">
            <h2>Escanea el código QR</h2>
            <p>Ábrelo con Google Authenticator, Authy, o la app de autenticación que uses.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qrCodeDataUrl} alt="Código QR para configurar la verificación en dos pasos" style={{ maxWidth: 220 }} />
            <p className="muted">¿No puedes escanearlo? Introduce este código manualmente en tu app: <code>{setup.secret}</code></p>
            <form onSubmit={confirmSetup}>
              <label className="field">
                Código de tu app
                <input
                  ref={confirmCodeRef}
                  name="code"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  required
                  minLength={6}
                  maxLength={6}
                  pattern="[0-9]{6}"
                  title="Los 6 dígitos que muestra tu app"
                />
              </label>
              <label className="field">
                Contraseña actual
                <input
                  ref={confirmPasswordRef}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  aria-describedby="confirm-password-hint"
                />
                <span id="confirm-password-hint" className="muted">
                  La pedimos para confirmar que eres tú quien activa la verificación.
                </span>
              </label>
              {confirmError && <p className="error" role="alert">{confirmError}</p>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="button secondary" onClick={cancelSetup}>Cancelar</button>
                <button type="submit" className="button primary" disabled={busy}>{busy ? 'Comprobando…' : 'Confirmar y activar'}</button>
              </div>
            </form>
          </section>
        ) : (
          <section className="patient-card">
            <h2>Activar verificación en dos pasos</h2>
            <p>Necesitarás una app de autenticación en tu móvil (Google Authenticator, Authy, etc.).</p>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="button primary" onClick={startSetup} disabled={busy}>
              {busy ? 'Generando…' : 'Empezar configuración'}
            </button>
          </section>
        )}

        <section className="patient-card">
          <h2>Desactivar verificación en dos pasos</h2>
          <p>Solo si ya la tienes activa. Necesitas tu contraseña y un código válido (o uno de recuperación).</p>
          <form onSubmit={disableMfa}>
            <label className="field">
              Contraseña
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <label className="field">
              Código
              <input name="code" autoComplete="one-time-code" required minLength={6} maxLength={11} />
            </label>
            {disableError && <p className="error" role="alert">{disableError}</p>}
            {disableNotice && <p role="status">{disableNotice}</p>}
            <button className="button secondary" type="submit" disabled={busy}>{busy ? 'Desactivando…' : 'Desactivar'}</button>
          </form>
        </section>
      </main>
    </div>
  );
}
