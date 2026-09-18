'use client';
import { FormEvent, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';

type SetupResponse = { qrCodeDataUrl: string; secret: string };
type ConfirmResponse = { recoveryCodes: string[] };

export default function SecurityPage() {
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [disableError, setDisableError] = useState('');
  const [busy, setBusy] = useState(false);

  async function startSetup() {
    setError('');
    setBusy(true);
    try {
      const result = await api<SetupResponse>('/auth/mfa/setup', { method: 'POST' });
      setSetup(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar la configuración');
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const data = new FormData(e.currentTarget);
    try {
      const result = await api<ConfirmResponse>('/auth/mfa/confirm', {
        method: 'POST',
        body: JSON.stringify({ code: data.get('code') }),
      });
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'El código no es correcto');
    } finally {
      setBusy(false);
    }
  }

  async function disableMfa(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDisableError('');
    setBusy(true);
    const data = new FormData(e.currentTarget);
    try {
      await api('/auth/mfa/disable', {
        method: 'POST',
        body: JSON.stringify({ password: data.get('password'), code: data.get('code') }),
      });
      e.currentTarget.reset();
      window.alert('Verificación en dos pasos desactivada.');
    } catch (err) {
      setDisableError(err instanceof Error ? err.message : 'No se pudo desactivar');
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
                <input name="code" autoFocus inputMode="numeric" placeholder="123456" required minLength={6} maxLength={6} />
              </label>
              {error && <p className="error">{error}</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="button secondary" onClick={() => setSetup(null)}>Cancelar</button>
                <button type="submit" className="button primary" disabled={busy}>{busy ? 'Comprobando…' : 'Confirmar y activar'}</button>
              </div>
            </form>
          </section>
        ) : (
          <section className="patient-card">
            <h2>Activar verificación en dos pasos</h2>
            <p>Necesitarás una app de autenticación en tu móvil (Google Authenticator, Authy, etc.).</p>
            {error && <p className="error">{error}</p>}
            <button className="button primary" onClick={startSetup} disabled={busy}>
              {busy ? 'Generando…' : 'Empezar configuración'}
            </button>
          </section>
        )}

        <section className="patient-card">
          <h2>Desactivar verificación en dos pasos</h2>
          <p>Solo si ya la tienes activa. Necesitas tu contraseña y un código válido (o uno de recuperación).</p>
          <form onSubmit={disableMfa}>
            <label className="field">Contraseña<input name="password" type="password" required /></label>
            <label className="field">Código<input name="code" required minLength={6} maxLength={11} /></label>
            {disableError && <p className="error">{disableError}</p>}
            <button className="button secondary" type="submit" disabled={busy}>{busy ? 'Desactivando…' : 'Desactivar'}</button>
          </form>
        </section>
      </main>
    </div>
  );
}
