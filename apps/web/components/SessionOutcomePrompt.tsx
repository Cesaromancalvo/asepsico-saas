'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Viewer } from '@/lib/clinical';
import {
  closeSessionOutcome,
  OutcomeSession,
  shouldAskOutcome,
  OUTCOME_OPTIONS,
  OUTCOME_QUESTION,
  SessionOutcome,
} from '@/lib/session-outcome';

/*
 * «¿Se hizo esta sesión? Realizada · No vino · Cancelada» para una cita que ya ha empezado y sigue
 * programada. Quien la monta decide si se enseña (shouldAskOutcome: estado, hora y rol). «Realizada»
 * se aplica con un clic; «No vino» y «Cancelada» piden confirmación porque no se pueden deshacer.
 * Nunca pide la nota de sesión: se añade después desde el detalle de la cita.
 */

type ViewProps = {
  /** Texto accesible del grupo: «paciente, día y hora» (sin datos clínicos). */
  context: string;
  busy: boolean;
  confirming: SessionOutcome | null;
  error: string;
  onPick: (status: SessionOutcome) => void;
  onConfirm: () => void;
  onBack: () => void;
};

export function SessionOutcomeView({ context, busy, confirming, error, onPick, onConfirm, onBack }: ViewProps) {
  const pending = confirming ? OUTCOME_OPTIONS.find((option) => option.status === confirming) ?? null : null;
  return (
    <div className="session-outcome" role="group" aria-label={`${OUTCOME_QUESTION} ${context}`}>
      {pending?.confirm ? (
        <>
          <p className="session-outcome-question">{pending.confirm}</p>
          <div className="session-outcome-buttons">
            <button type="button" className="session-outcome-confirm" disabled={busy} onClick={onConfirm}>
              {busy ? 'Guardando…' : `Sí, «${pending.label}»`}
            </button>
            {/* El foco va a «Volver»: un Enter de más no cierra la cita sin querer. */}
            <button type="button" disabled={busy} onClick={onBack} autoFocus>Volver</button>
          </div>
        </>
      ) : (
        <>
          <p className="session-outcome-question">{OUTCOME_QUESTION}</p>
          <div className="session-outcome-buttons">
            {OUTCOME_OPTIONS.map((option) => (
              <button
                key={option.status}
                type="button"
                className={option.status === 'COMPLETED' ? 'session-outcome-primary' : undefined}
                disabled={busy}
                onClick={() => onPick(option.status)}
              >
                {busy && option.status === confirming ? 'Guardando…' : option.label}
              </button>
            ))}
          </div>
        </>
      )}
      {error && <p className="session-outcome-error" role="alert">{error}</p>}
    </div>
  );
}

export default function SessionOutcomePrompt({
  sessionId,
  context,
  onClosed,
}: {
  sessionId: string;
  context: string;
  /** Tras cerrar con éxito: la pantalla recarga y enseña su aviso (outcomeNotice). */
  onClosed: (status: SessionOutcome) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<SessionOutcome | null>(null);
  const [error, setError] = useState('');

  async function apply(status: SessionOutcome) {
    setBusy(true);
    setConfirming(status);
    setError('');
    try {
      await closeSessionOutcome(sessionId, status);
      setConfirming(null);
      await onClosed(status);
    } catch (err) {
      setConfirming(null);
      setError(err instanceof Error && err.message ? err.message : 'No se ha podido guardar. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  function pick(status: SessionOutcome) {
    const option = OUTCOME_OPTIONS.find((o) => o.status === status);
    if (option?.confirm) {
      setError('');
      setConfirming(status);
      return;
    }
    void apply(status);
  }

  return (
    <SessionOutcomeView
      context={context}
      busy={busy}
      confirming={confirming}
      error={error}
      onPick={pick}
      onConfirm={() => { if (confirming) void apply(confirming); }}
      onBack={() => setConfirming(null)}
    />
  );
}

/**
 * Citas de un paciente que ya han empezado y siguen programadas, y que este usuario puede cerrar.
 * Para la línea temporal de la ficha, que no trae el profesional de cada cita: se pregunta a
 * GET /sessions (solo metadatos; a un THERAPIST la API le devuelve únicamente las suyas).
 * Si falla, no se pregunta nada (la línea temporal se sigue viendo igual).
 */
export function usePendingOutcomeSessions(patientId: string, viewer: Viewer | null, enabled: boolean) {
  const [sessions, setSessions] = useState<Map<string, OutcomeSession>>(new Map());
  const reload = useCallback(async () => {
    if (!enabled || !patientId || !viewer?.role) { setSessions(new Map()); return; }
    try {
      const now = new Date();
      const params = new URLSearchParams({ patientId, status: 'SCHEDULED', to: now.toISOString(), pageSize: '100' });
      const page = await api<{ data: OutcomeSession[] }>(`/sessions?${params.toString()}`);
      setSessions(new Map((page?.data ?? []).filter((s) => shouldAskOutcome(s, viewer, now)).map((s) => [s.id, s])));
    } catch {
      setSessions(new Map());
    }
  }, [patientId, viewer, enabled]);
  useEffect(() => { void reload(); }, [reload]);
  return { sessions, reload };
}
