'use client';

import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import NoticeText from '@/components/NoticeText';
import {
  ageInYears, MIN_SIGNUP_AGE, MINOR_SIGNUP_MESSAGE, PORTAL_SIGNUP_NOTICE_VERSIONS, PublicRequestError, submitSignupRequest, tokenFromHash,
} from '@/lib/portal-signup';
import {
  DRAFT_NOTICE, EMERGENCY_TEXT, EMERGENCY_TITLE, LAYER1, PORTAL_TERMS_LABEL, PORTAL_TERMS_LABEL_BEFORE, PORTAL_TERMS_LINK, PRIVACY_ACK_LABEL,
} from '@/lib/portal-signup-texts';

type Step = 'loading' | 'no-token' | 'form' | 'sent' | 'minor';

const NAME_PATTERN = "[A-Za-zÀ-ÖØ-öø-ÿ .'’\\-]+";
const PHONE_PATTERN = '\\+?[0-9 ]{6,20}';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Solicitud pública de acceso al portal desde el QR fijo de un profesional. Enviarla NO crea
 * ninguna cuenta: la consulta la revisa y entrega la activación en persona. No nombra al
 * profesional, y la respuesta es siempre la misma (QR válido o no): no permite averiguar nada.
 * Por debajo de la edad mínima no se envía ningún dato y se remite al alta en persona.
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
    if (!token || !privacyAck || !termsAccepted) return;
    setError('');
    const data = new FormData(event.currentTarget);
    const birthDate = String(data.get('birthDate') ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) { setError('Indica tu fecha de nacimiento.'); return; }
    // Por debajo de la edad mínima no se envía ningún dato.
    if (ageInYears(birthDate) < MIN_SIGNUP_AGE) { setStep('minor'); return; }
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

  const ready = privacyAck && termsAccepted;

  return (
    <main className="portal-login ps-public">
      <section aria-labelledby={`${id}-title`}>
        <span className="eyebrow">Portal de pacientes</span>

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
            <h1 id={`${id}-title`} ref={resultRef} tabIndex={-1}>El alta la hace tu consulta en persona</h1>
            <p>{MINOR_SIGNUP_MESSAGE}</p>
            <p>No hemos enviado ningún dato. Ya puedes cerrar esta página.</p>
          </div>
        )}

        {step === 'form' && (
          <>
            <p className="ps-draft" role="note">{DRAFT_NOTICE}</p>
            <h1 id={`${id}-title`} className="ps-public-title"><NoticeText text={LAYER1.title} /></h1>
            <p>
              <NoticeText text={LAYER1.intro} /><strong>{LAYER1.introStrong}</strong>{LAYER1.introEnd}
            </p>

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
                <small id={`${id}-birth-hint`}>El alta con este código es para mayores de {MIN_SIGNUP_AGE} años. Si tienes menos, la consulta te dará de alta en persona.</small>
              </label>

              <div className="ps-notice" aria-labelledby={`${id}-notice-title`} role="region">
                <h2 id={`${id}-notice-title`}>{LAYER1.heading}</h2>
                <dl>
                  {LAYER1.items.map((item) => (
                    <div key={item.term}><dt>{item.term}</dt><dd><NoticeText text={item.text} /></dd></div>
                  ))}
                </dl>
                <a className="ps-notice-link" href="/portal/alta/informacion" target="_blank" rel="noopener noreferrer">
                  {LAYER1.fullInfoLink}<span className="sr-only"> (se abre en otra pestaña)</span>
                </a>
              </div>

              <p className="ps-emergency" role="note"><strong>{EMERGENCY_TITLE}</strong> {EMERGENCY_TEXT}</p>

              <label className="ps-check">
                <input type="checkbox" checked={privacyAck} onChange={(event) => setPrivacyAck(event.target.checked)} />
                <span>{PRIVACY_ACK_LABEL}</span>
              </label>
              <div className="ps-check">
                <input id={`${id}-terms`} type="checkbox" aria-label={PORTAL_TERMS_LABEL} checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} />
                <span>
                  <label htmlFor={`${id}-terms`}>{PORTAL_TERMS_LABEL_BEFORE}</label>
                  <a href="/portal/alta/normas" target="_blank" rel="noopener noreferrer">{PORTAL_TERMS_LINK}<span className="sr-only"> (se abre en otra pestaña)</span></a>.
                </span>
              </div>

              {error && <div className="agenda-error" role="alert">{error}</div>}
              <button className="button primary" type="submit" disabled={busy || !ready} aria-describedby={ready ? undefined : `${id}-submit-hint`}>
                {busy ? 'Enviando…' : 'Enviar solicitud'}
              </button>
              {!ready && <small id={`${id}-submit-hint`} className="ps-submit-hint">Marca las dos casillas para poder enviarla.</small>}
            </form>
          </>
        )}
      </section>
    </main>
  );
}
