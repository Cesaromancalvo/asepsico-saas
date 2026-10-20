'use client';

import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import {
  ageInYears, MIN_SIGNUP_AGE, MINOR_SIGNUP_MESSAGE, PORTAL_SIGNUP_NOTICE_VERSIONS, PORTAL_TERMS_LABEL, PORTAL_TERMS_SUMMARY,
  PRIVACY_ACK_LABEL, PRIVACY_NOTICE_LAYER1, PublicRequestError, submitSignupRequest, tokenFromHash,
} from '@/lib/portal-signup';

type Step = 'loading' | 'no-token' | 'form' | 'sent' | 'minor';

const NAME_PATTERN = "[A-Za-zÀ-ÖØ-öø-ÿ .'’\\-]+";
const PHONE_PATTERN = '\\+?[0-9 ]{6,20}';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Alta pública en el portal desde el QR fijo de un profesional. No muestra el nombre de la
 * consulta ni del profesional, y la respuesta es siempre la misma (QR válido o no): no permite
 * averiguar nada. Con menos de 16 años no se envía nada y se explica que el alta es presencial
 * con la familia.
 */
export default function PortalSignupPage() {
  const id = useId();
  const [step, setStep] = useState<Step>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [privacyAck, setPrivacyAck] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentMessage, setSentMessage] = useState('');
  const resultRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const value = tokenFromHash(window.location.hash);
    setToken(value);
    setStep(value ? 'form' : 'no-token');
  }, []);

  useEffect(() => {
    if (step === 'sent' || step === 'minor') resultRef.current?.focus();
  }, [step]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setError('');
    const data = new FormData(event.currentTarget);
    const birthDate = String(data.get('birthDate') ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) { setError('Indica tu fecha de nacimiento.'); return; }
    // Regla de menores (C6): no se envía ningún dato de un menor de 16.
    if (ageInYears(birthDate) < MIN_SIGNUP_AGE) { setStep('minor'); return; }
    if (!privacyAck || !termsAccepted) { setError('Para continuar, marca las dos casillas.'); return; }
    const phone = String(data.get('phone') ?? '').trim();
    setBusy(true);
    try {
      const result = await submitSignupRequest({
        token,
        firstName: String(data.get('firstName') ?? '').trim(),
        lastName: String(data.get('lastName') ?? '').trim(),
        email: String(data.get('email') ?? '').trim(),
        ...(phone ? { phone } : {}),
        birthDate,
        privacyNoticeAcknowledged: true,
        portalTermsAccepted: true,
        privacyNoticeVersion: PORTAL_SIGNUP_NOTICE_VERSIONS.privacyNotice,
        portalTermsVersion: PORTAL_SIGNUP_NOTICE_VERSIONS.portalTerms,
      });
      setSentMessage(result.message);
      setStep('sent');
      // El enlace ya no hace falta: fuera del historial y de la barra de direcciones.
      window.history.replaceState(null, '', window.location.pathname);
    } catch (err) {
      if (err instanceof PublicRequestError && err.code === 'PORTAL_SIGNUP_MIN_AGE') { setStep('minor'); return; }
      if (err instanceof PublicRequestError && err.status === 400) {
        setError('Revisa los datos: hay algún campo con un formato no válido.');
      } else {
        setError(err instanceof Error && err.message ? err.message : 'No se ha podido enviar. Vuelve a intentarlo.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="portal-login ps-public">
      <section aria-labelledby={`${id}-title`}>
        <span className="eyebrow">Portal del paciente</span>

        {step === 'loading' && <p role="status">Cargando…</p>}

        {step === 'no-token' && (
          <>
            <h1 id={`${id}-title`}>Este enlace no está completo</h1>
            <p>Vuelve a escanear el código QR de tu consulta con la cámara del móvil.</p>
          </>
        )}

        {step === 'sent' && (
          <div className="ps-result">
            <h1 id={`${id}-title`} ref={resultRef} tabIndex={-1}>Solicitud enviada</h1>
            <p>{sentMessage}</p>
            <p>Ya puedes cerrar esta página.</p>
          </div>
        )}

        {step === 'minor' && (
          <div className="ps-result">
            <h1 id={`${id}-title`} ref={resultRef} tabIndex={-1}>El alta la hace tu consulta</h1>
            <p>{MINOR_SIGNUP_MESSAGE}</p>
            <p>No hemos enviado ningún dato. Ya puedes cerrar esta página.</p>
          </div>
        )}

        {step === 'form' && (
          <>
            <h1 id={`${id}-title`}>Pide tu acceso al portal</h1>
            <p>Déjanos tus datos. Tu consulta comprobará que eres tú y te dará en persona el enlace para elegir tu contraseña.</p>

            <form onSubmit={submit} className="ps-public-form">
              <div className="ps-public-grid">
                <label>Nombre<input name="firstName" autoComplete="given-name" required maxLength={80} pattern={NAME_PATTERN} /></label>
                <label>Apellidos<input name="lastName" autoComplete="family-name" required maxLength={120} pattern={NAME_PATTERN} /></label>
              </div>
              <label>Correo electrónico<input name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} /></label>
              <label>
                <span>Teléfono <span className="ps-optional">(opcional)</span></span>
                <input name="phone" type="tel" autoComplete="tel" inputMode="tel" maxLength={20} pattern={PHONE_PATTERN} aria-describedby={`${id}-phone-hint`} />
                <small id={`${id}-phone-hint`}>Solo números; puedes empezar por +34.</small>
              </label>
              <label>
                Fecha de nacimiento
                <input name="birthDate" type="date" required min="1900-01-01" max={todayIso()} aria-describedby={`${id}-birth-hint`} />
                <small id={`${id}-birth-hint`}>Con menos de 16 años, el alta se hace en la consulta con tu familia.</small>
              </label>

              <div className="ps-notice" aria-labelledby={`${id}-notice-title`} role="region">
                <h2 id={`${id}-notice-title`}>{PRIVACY_NOTICE_LAYER1.title}</h2>
                <dl>
                  {PRIVACY_NOTICE_LAYER1.items.map((item) => (
                    <div key={item.term}><dt>{item.term}</dt><dd>{item.text}</dd></div>
                  ))}
                </dl>
                <details className="ps-details">
                  <summary>Normas de uso del portal</summary>
                  <ul>{PORTAL_TERMS_SUMMARY.map((line) => <li key={line}>{line}</li>)}</ul>
                </details>
              </div>

              <label className="ps-check">
                <input type="checkbox" checked={privacyAck} onChange={(event) => setPrivacyAck(event.target.checked)} />
                <span>{PRIVACY_ACK_LABEL}</span>
              </label>
              <label className="ps-check">
                <input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} />
                <span>{PORTAL_TERMS_LABEL}</span>
              </label>

              {error && <div className="agenda-error" role="alert">{error}</div>}
              <button className="button primary" type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Enviar solicitud'}</button>
            </form>
            <small>Este portal no es un canal de urgencias. Si lo necesitas, llama al 024 o al 112.</small>
          </>
        )}
      </section>
    </main>
  );
}
