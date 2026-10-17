'use client';
import { FormEvent, useRef, useState } from 'react';
import type { ChangePasswordResponseContract } from '@asepsico/contracts';
import { api, apiErrorCode, ApiError } from '@/lib/api';
import {
  ChangePasswordField,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  changePasswordBody,
  validateChangePassword,
} from '@/lib/password-change';

type Props = {
  /** La cuenta tiene el MFA activo: se pide además el código de la app. */
  mfaEnabled: boolean;
};

const FIELDS: ChangePasswordField[] = ['currentPassword', 'newPassword', 'repeatPassword', 'mfaCode'];

/**
 * Cambio de contraseña del profesional (POST /auth/change-password). Las contraseñas nunca se
 * guardan en el estado de React: se leen del formulario al enviar y se vacían siempre después.
 */
export default function ChangePasswordForm({ mfaEnabled }: Props) {
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<ChangePasswordField | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // La API puede pedir el código aunque /auth/me aún no lo supiera (MFA recién activado en otra pestaña).
  const [codeRequired, setCodeRequired] = useState(mfaEnabled);
  const needsCode = mfaEnabled || codeRequired;
  const refs = {
    currentPassword: useRef<HTMLInputElement>(null),
    newPassword: useRef<HTMLInputElement>(null),
    repeatPassword: useRef<HTMLInputElement>(null),
    mfaCode: useRef<HTMLInputElement>(null),
  };

  function clear(...fields: ChangePasswordField[]) {
    for (const field of fields) if (refs[field].current) refs[field].current.value = '';
  }

  function showError(message: string, field: ChangePasswordField | null) {
    setError(message);
    setErrorField(field);
    if (field) setTimeout(() => refs[field].current?.focus(), 0);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const fields = {
      currentPassword: String(data.get('currentPassword') ?? ''),
      newPassword: String(data.get('newPassword') ?? ''),
      repeatPassword: String(data.get('repeatPassword') ?? ''),
      mfaCode: String(data.get('mfaCode') ?? '').trim(),
    };
    setNotice('');
    const problem = validateChangePassword(fields, needsCode);
    if (problem) {
      showError(problem.message, problem.field);
      return;
    }
    setError('');
    setErrorField(null);
    setBusy(true);
    try {
      await api<ChangePasswordResponseContract>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify(changePasswordBody(fields, needsCode)),
      });
      clear(...FIELDS);
      setNotice('Contraseña cambiada. Hemos cerrado tu sesión en los demás dispositivos y navegadores; en este sigues conectado.');
    } catch (err) {
      const code = apiErrorCode(err);
      const message = err instanceof Error && err.message ? err.message : 'No se pudo cambiar la contraseña.';
      clear('currentPassword', 'mfaCode');
      if (code === 'MFA_CODE_REQUIRED') {
        setCodeRequired(true);
        showError(message, 'mfaCode');
      } else if (code === 'PASSWORD_UNCHANGED') {
        showError(message, 'newPassword');
      } else if (err instanceof ApiError && err.status === 400) {
        // Validación de la API (longitud, formato del código): el texto ya dice qué campo.
        showError(message, 'newPassword');
      } else {
        // 401 genérico (contraseña o código), 429 (espera o límite) u otros: el texto de la API tal cual.
        showError(message, 'currentPassword');
      }
    } finally {
      setBusy(false);
    }
  }

  const describedBy = (field: ChangePasswordField, hint?: string) =>
    [hint, errorField === field ? 'change-password-error' : null].filter(Boolean).join(' ') || undefined;

  return (
    <section className="patient-card" aria-labelledby="change-password-title">
      <h2 id="change-password-title">Cambiar contraseña</h2>
      <p>Al cambiarla cerraremos tu sesión en todos los demás dispositivos y navegadores.</p>
      <form onSubmit={submit} noValidate>
        <label className="field">
          Contraseña actual
          <input
            ref={refs.currentPassword}
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={errorField === 'currentPassword' || undefined}
            aria-describedby={describedBy('currentPassword')}
          />
        </label>
        <label className="field">
          Nueva contraseña
          <input
            ref={refs.newPassword}
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            aria-invalid={errorField === 'newPassword' || undefined}
            aria-describedby={describedBy('newPassword', 'new-password-hint')}
          />
          <span id="new-password-hint" className="muted">
            Mínimo {PASSWORD_MIN_LENGTH} caracteres y como mucho unos {PASSWORD_MAX_BYTES}. Mejor una frase que solo uses aquí.
          </span>
        </label>
        <label className="field">
          Repite la nueva contraseña
          <input
            ref={refs.repeatPassword}
            name="repeatPassword"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={errorField === 'repeatPassword' || undefined}
            aria-describedby={describedBy('repeatPassword')}
          />
        </label>
        {needsCode && (
          <label className="field">
            Código de tu app de verificación
            <input
              ref={refs.mfaCode}
              name="mfaCode"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={6}
              pattern="[0-9]{6}"
              aria-invalid={errorField === 'mfaCode' || undefined}
              aria-describedby={describedBy('mfaCode', 'mfa-code-hint')}
            />
            <span id="mfa-code-hint" className="muted">Los 6 dígitos que muestra ahora tu app.</span>
          </label>
        )}
        {error && <p id="change-password-error" className="error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <button className="button primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Cambiando…' : 'Cambiar contraseña'}
        </button>
      </form>
    </section>
  );
}
