'use client';

import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import type { CreateExceptionalAccessResponse, StaffRole } from '@asepsico/contracts';
import { api, ApiError, apiErrorCode } from '@/lib/api';
import {
  CLINICAL_TERMS_WARNING,
  CLINICAL_TERMS_WARNING_TEXT,
  CONFIRMATION_TEXT,
  EMPTY_EXCEPTIONAL_FORM,
  EXCEPTIONAL_ACCESS_HOURS,
  EXCEPTIONAL_ACCESS_NOT_NEEDED,
  EXCEPTIONAL_REASON_OPTION_TEXT,
  JUSTIFICATION_EXAMPLES,
  JUSTIFICATION_MAX,
  REASON_MISS_TEXT,
  buildExceptionalRequest,
  canDeferNotice,
  exceptionalReasonLabel,
  formatDateTime,
  isClinicalExceptionalReason,
  untilText,
  validateExceptionalForm,
  visibleReasons,
  type ExceptionalAccessForm,
  type ExceptionalAccessReasonCode,
} from '@/lib/exceptional-access';

/** Estado del modal al abrirlo y tras cerrarlo: nada escrito, nada registrado. */
export function initialDialogState() {
  return { form: { ...EMPTY_EXCEPTIONAL_FORM }, busy: false, error: '', clinicalWarning: false, reasonMiss: false, created: null as CreateExceptionalAccessResponse | null };
}

type Props = {
  open: boolean;
  patientId: string;
  role: StaffRole | null;
  /** Códigos que la API deja usar a este usuario (GET .../exceptional-access/current). */
  allowedReasons: readonly string[];
  onClose: () => void;
  /** Se ha registrado (o ya había uno vigente): la ficha vuelve a preguntar a la API. */
  onRegistered: () => void;
};

/**
 * Modal único del acceso excepcional (§3.3): aviso, motivo + explicación y confirmación, sin
 * pasos. <dialog> nativo con showModal(): foco atrapado, Escape para cerrar, rol de diálogo modal
 * y el foco vuelve al botón que lo abrió. La API vuelve a comprobarlo todo.
 */
export default function ExceptionalAccessDialog({ open, patientId, role, allowedReasons, onClose, onRegistered }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const firstReasonRef = useRef<HTMLInputElement>(null);
  const justificationRef = useRef<HTMLTextAreaElement>(null);
  const deferRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const [form, setForm] = useState<ExceptionalAccessForm>(EMPTY_EXCEPTIONAL_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [clinicalWarning, setClinicalWarning] = useState(false);
  const [reasonMiss, setReasonMiss] = useState(false);
  const [created, setCreated] = useState<CreateExceptionalAccessResponse | null>(null);
  const id = useId();

  const reasons = visibleReasons(allowedReasons);
  const problem = validateExceptionalForm(form, reasons, role);
  const deferAllowed = canDeferNotice(role, form.reasonCode);

  function resetDialog() {
    const initial = initialDialogState();
    setForm(initial.form); setBusy(initial.busy); setError(initial.error);
    setClinicalWarning(initial.clinicalWarning); setReasonMiss(initial.reasonMiss); setCreated(initial.created);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      resetDialog();
      dialog.showModal();
      requestAnimationFrame(() => firstReasonRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function handleClosed() {
    if (created) onRegistered();
    // Al cerrar no queda nada escrito en memoria (explicación incluida) para la próxima apertura.
    resetDialog();
    onClose();
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target && document.contains(target)) target.focus();
  }

  function update<K extends keyof ExceptionalAccessForm>(key: K, value: ExceptionalAccessForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (error) setError('');
    if (key === 'justification' && clinicalWarning) setClinicalWarning(false);
  }

  async function send(acknowledged: boolean) {
    if (problem) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<CreateExceptionalAccessResponse>(`/patients/${patientId}/exceptional-access`, {
        method: 'POST',
        body: JSON.stringify(buildExceptionalRequest(form, role, acknowledged)),
      });
      setClinicalWarning(false);
      setCreated(result);
    } catch (err) {
      const code = apiErrorCode(err);
      if (code === CLINICAL_TERMS_WARNING) {
        setClinicalWarning(true);
        requestAnimationFrame(() => continueRef.current?.focus());
      } else if (code === EXCEPTIONAL_ACCESS_NOT_NEEDED) {
        // Ya atiende al paciente o ya tiene uno vigente: no hay nada que registrar.
        setError(err instanceof Error ? err.message : 'Ya tienes acceso a este paciente.');
        onRegistered();
      } else if (err instanceof ApiError && err.status === 403) {
        setError('No puedes registrar un acceso excepcional con este motivo. Si crees que es un error, consulta con la dirección de la consulta.');
      } else {
        setError(err instanceof Error ? err.message : 'No se pudo registrar el acceso.');
      }
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (problem) {
      const target = { reasonCode: firstReasonRef, justification: justificationRef, deferReason: deferRef, confirmed: confirmRef }[problem.field];
      target.current?.focus();
      return;
    }
    void send(false);
  }

  async function countReasonMiss() {
    setReasonMiss(true);
    // Solo un contador agregado por consulta (sin paciente, usuario ni texto). Si falla, da igual.
    try { await api('/exceptional-access/reason-miss', { method: 'POST' }); } catch { /* sin efecto para el usuario */ }
  }

  const titleId = `${id}-title`;
  const noticeId = `${id}-notice`;
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  const problemId = `${id}-problem`;
  const deferHintId = `${id}-defer-hint`;
  const length = form.justification.trim().length;

  return (
    <dialog
      ref={dialogRef}
      className="agenda-modal reason-dialog xa-dialog"
      aria-labelledby={titleId}
      aria-describedby={noticeId}
      onClose={handleClosed}
      onCancel={(event) => { if (busy) event.preventDefault(); }}
    >
      {open && !created && (
        <form onSubmit={submit} noValidate>
          <div className="agenda-modal-header">
            <h2 id={titleId}>Vas a abrir la historia de un paciente que no atiendes</h2>
            <button type="button" aria-label="Cerrar" disabled={busy} onClick={() => dialogRef.current?.close()}>×</button>
          </div>

          {/* Bloque 1: aviso */}
          <div id={noticeId} className="xa-warning">
            <p>Solo puedes hacerlo por uno de los motivos de la lista. Quedará registrado quién entra, cuándo y por qué. La dirección de la consulta puede revisarlo, el terapeuta de este paciente recibirá un aviso y el propio paciente puede pedir saber cuándo y por qué se consultó su historia.</p>
            <p>Todo lo que veas está sujeto a secreto profesional.</p>
            <p><strong>El acceso es de solo lectura, no incluye las notas internas de los profesionales, dura {EXCEPTIONAL_ACCESS_HOURS} horas y se cierra si cierras sesión.</strong></p>
          </div>

          {/* Bloque 2: motivo y explicación */}
          <fieldset className="xa-fieldset" disabled={busy}>
            <legend>Motivo <span className="xa-required">(obligatorio)</span></legend>
            <div className="xa-options">
              {reasons.map((code: ExceptionalAccessReasonCode, index) => (
                <label key={code} className={`xa-option${form.reasonCode === code ? ' is-selected' : ''}`}>
                  <input
                    ref={index === 0 ? firstReasonRef : undefined}
                    type="radio"
                    name={`${id}-reason`}
                    value={code}
                    checked={form.reasonCode === code}
                    onChange={() => update('reasonCode', code)}
                  />
                  <span>
                    {EXCEPTIONAL_REASON_OPTION_TEXT[code]}
                    <small>{isClinicalExceptionalReason(code) ? 'Clínico' : 'Administrativo'}</small>
                  </span>
                </label>
              ))}
            </div>
            {form.reasonCode === 'CONTINUITY_OF_CARE' && (
              <p className="xa-help" role="note">¿Vas a llevar a este paciente varios días? Ábrete un proceso con él (o ábreselo al profesional que lo sustituye).</p>
            )}
            <button type="button" className="xa-link" onClick={countReasonMiss} aria-expanded={reasonMiss}>Mi motivo no está en la lista</button>
            {reasonMiss && <p className="xa-miss" role="status">{REASON_MISS_TEXT}</p>}
          </fieldset>

          <label className="field xa-field">
            <span>Explicación breve <span className="xa-required">(obligatoria, {`20–${JUSTIFICATION_MAX}`} caracteres)</span></span>
            <textarea
              ref={justificationRef}
              rows={3}
              maxLength={JUSTIFICATION_MAX}
              value={form.justification}
              disabled={busy}
              onChange={(event) => update('justification', event.target.value)}
              aria-describedby={`${hintId} ${countId}`}
            />
          </label>
          <div className="xa-hint" id={hintId}>
            <p>Explica el <strong>porqué administrativo</strong>, no el clínico. Por ejemplo: {JUSTIFICATION_EXAMPLES.map((example) => `«${example}»`).join(' · ')}</p>
            <p><strong>No escribas</strong> diagnósticos, síntomas, medicación, contenido de sesiones, valoraciones sobre el paciente ni datos de otras personas. <strong>El paciente puede leer esta explicación.</strong></p>
          </div>
          <small id={countId} className={`reason-dialog-count${length > 0 && length < 20 ? ' is-near' : ''}`}>{length}/{JUSTIFICATION_MAX} caracteres</small>

          {deferAllowed && (
            <div className="xa-defer">
              <label className="e1-checkbox">
                <input type="checkbox" checked={form.deferNotice} disabled={busy} onChange={(event) => update('deferNotice', event.target.checked)} />
                <span>Diferir el aviso al terapeuta<small>Solo si avisarle ahora perjudicaría el requerimiento o la reclamación. Te lo recordaremos cada 30 días hasta que lo liberes.</small></span>
              </label>
              {form.deferNotice && (
                <label className="field xa-field">
                  <span>Motivo para diferir el aviso <span className="xa-required">(20–{JUSTIFICATION_MAX} caracteres)</span></span>
                  <textarea ref={deferRef} rows={2} maxLength={JUSTIFICATION_MAX} value={form.deferReason} disabled={busy} onChange={(event) => update('deferReason', event.target.value)} aria-describedby={deferHintId} />
                  <small id={deferHintId} className="muted">Sin datos clínicos. Solo lo puede leer la dirección.</small>
                </label>
              )}
            </div>
          )}

          {/* Bloque 3: confirmación */}
          <label className="e1-checkbox xa-confirm">
            <input ref={confirmRef} type="checkbox" checked={form.confirmed} disabled={busy} onChange={(event) => update('confirmed', event.target.checked)} />
            <span>{CONFIRMATION_TEXT}</span>
          </label>

          {clinicalWarning && (
            <div className="e1-notice xa-clinical-warning" role="alert">
              <div>
                <strong>Revisa la explicación</strong>
                <p>{CLINICAL_TERMS_WARNING_TEXT}</p>
              </div>
              <div className="e1-notice-actions">
                <button type="button" className="button secondary" disabled={busy} onClick={() => { setClinicalWarning(false); justificationRef.current?.focus(); }}>Corregir</button>
                <button ref={continueRef} type="button" className="button" disabled={busy} onClick={() => send(true)}>Es correcto, continuar</button>
              </div>
            </div>
          )}

          {error && <p className="agenda-error reason-dialog-error" role="alert">{error}</p>}
          {problem && <p id={problemId} className="xa-problem" aria-live="polite">{problem.message}</p>}

          <div className="agenda-modal-actions">
            <button type="button" className="agenda-cancel-button" disabled={busy} onClick={() => dialogRef.current?.close()}>Cancelar</button>
            {!clinicalWarning && (
              <button type="submit" className="button" disabled={busy || Boolean(problem)} aria-describedby={problem ? problemId : undefined}>
                {busy ? 'Registrando…' : 'Abrir historia'}
              </button>
            )}
          </div>
        </form>
      )}

      {open && created && (
        <div className="xa-done" role="status">
          <div className="agenda-modal-header">
            <h2 id={titleId}>Acceso registrado</h2>
            <button type="button" aria-label="Cerrar" onClick={() => dialogRef.current?.close()}>×</button>
          </div>
          <p id={noticeId}>
            Acceso registrado el {formatDateTime(created.createdAt)}. Motivo: {exceptionalReasonLabel(created.reasonCode)}.
            {' '}Válido {untilText(created.expiresAt)} o hasta que cierres sesión.
          </p>
          <p>Si hay que corregir la explicación, pídeselo a la dirección de la consulta.</p>
          {created.reasonCode === 'VITAL_URGENCY' && <p><strong>La dirección revisará este acceso en las próximas 72 horas.</strong></p>}
          {created.noticeDeferred && <p>El aviso al terapeuta queda diferido. Libéralo desde Accesos excepcionales cuando ya no haga falta esperar.</p>}
          <div className="agenda-modal-actions">
            <button type="button" className="button" autoFocus onClick={() => dialogRef.current?.close()}>Ver la historia</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
