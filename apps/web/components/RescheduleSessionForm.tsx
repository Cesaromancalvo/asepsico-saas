'use client';

import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import {
  buildRescheduleRange,
  DURATION_OPTIONS,
  fetchWorkspaceTimeZone,
  PENDING_REQUESTS_NOTICE,
  ReschedulableSession,
  rescheduleDefaults,
  rescheduleErrorField,
  rescheduleErrorMessage,
  rescheduleSession,
} from '@/lib/reschedule';

type Field = 'date' | 'time' | 'duration';

export type RescheduleSessionFormProps<T> = {
  session: ReschedulableSession;
  /** Nombre del paciente para el encabezado (dato administrativo, como en la agenda). */
  patientName?: string;
  onCancel: () => void;
  onSaved: (updated: T | null, range: { startsAt: string; endsAt: string }, timeZone: string) => void;
  /** Zona horaria de la consulta; si no llega, se pide a la API (GET /scheduling/time-zone). */
  timeZone?: string;
  /** Solo para tests: fecha "ahora". */
  now?: Date;
  /** Solo para tests: sustituye la llamada a la API. */
  submit?: (sessionId: string, body: { startsAt: string; endsAt: string }) => Promise<T>;
};

/**
 * Formulario «Cambiar fecha u hora» de una cita programada: fecha, hora y duración.
 * Usa el estilo `.agenda-form` de la agenda. Los errores se anuncian (role="alert") y el foco va al
 * campo que hay que corregir.
 */
export default function RescheduleSessionForm<T>(props: RescheduleSessionFormProps<T>) {
  const [timeZone, setTimeZone] = useState(props.timeZone ?? '');
  useEffect(() => {
    if (props.timeZone) return;
    let cancelled = false;
    void fetchWorkspaceTimeZone().then((tz) => { if (!cancelled) setTimeZone(tz); });
    return () => { cancelled = true; };
  }, [props.timeZone]);

  if (!timeZone) {
    return (
      <section className="dashboard-card agenda-form-card reschedule-card">
        <p className="reschedule-hint" role="status">Preparando el formulario…</p>
      </section>
    );
  }
  return <RescheduleFields<T> {...props} timeZone={timeZone} />;
}

function RescheduleFields<T>({ session, patientName, onCancel, onSaved, now, submit, timeZone }: RescheduleSessionFormProps<T> & { timeZone: string }) {
  const initial = rescheduleDefaults(session, timeZone);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const durations: number[] = (DURATION_OPTIONS as readonly number[]).includes(initial.duration)
    ? [...DURATION_OPTIONS]
    : [...DURATION_OPTIONS, initial.duration].sort((a, b) => a - b);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [duration, setDuration] = useState(initial.duration);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<Field | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const refs = {
    date: useRef<HTMLInputElement>(null),
    time: useRef<HTMLInputElement>(null),
    duration: useRef<HTMLSelectElement>(null),
  };

  // Al abrir, el foco va a la fecha (teclado y lectores de pantalla saben dónde están).
  useEffect(() => {
    refs.date.current?.focus();
  }, []);

  function fail(message: string, field: Field | null) {
    setError(message);
    setErrorField(field);
    if (field) refs[field].current?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const result = buildRescheduleRange({ date, time, duration }, session, now ?? new Date(), timeZone);
    if ('error' in result) {
      fail(result.error, result.field);
      return;
    }
    try {
      setSaving(true);
      setError('');
      setErrorField(null);
      const updated = await (submit ?? rescheduleSession<T>)(session.id, result.range);
      onSaved(updated ?? null, result.range, timeZone);
    } catch (err) {
      fail(rescheduleErrorMessage(err), rescheduleErrorField(err));
    } finally {
      setSaving(false);
    }
  }

  const errorId = `${id}-error`;
  const describedBy = (field: Field) => (error && errorField === field ? errorId : undefined);

  return (
    <section className="dashboard-card agenda-form-card reschedule-card" aria-labelledby={`${id}-title`}>
      <div className="card-heading">
        <div>
          <p className="eyebrow">MOVER CITA</p>
          <h2 id={`${id}-title`}>Cambiar fecha u hora{patientName ? ` · ${patientName}` : ''}</h2>
        </div>
        <button type="button" className="small-secondary" onClick={onCancel}>Cerrar</button>
      </div>

      <form className="agenda-form" onSubmit={handleSubmit} noValidate>
        <label>
          <span>Fecha</span>
          <input
            ref={refs.date}
            name="date"
            type="date"
            required
            value={date}
            onChange={(event) => { setDate(event.target.value); setError(''); setErrorField(null); }}
            aria-invalid={errorField === 'date' || undefined}
            aria-describedby={describedBy('date')}
          />
        </label>

        <label>
          <span>Hora</span>
          <input
            ref={refs.time}
            name="time"
            type="time"
            step={300}
            required
            value={time}
            onChange={(event) => { setTime(event.target.value); setError(''); setErrorField(null); }}
            aria-invalid={errorField === 'time' || undefined}
            aria-describedby={describedBy('time')}
          />
        </label>

        <label>
          <span>Duración</span>
          <select
            ref={refs.duration}
            name="duration"
            value={duration}
            onChange={(event) => { setDuration(Number(event.target.value)); setError(''); setErrorField(null); }}
            aria-invalid={errorField === 'duration' || undefined}
            aria-describedby={describedBy('duration')}
          >
            {durations.map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
          </select>
        </label>

        <div className="agenda-form-notes reschedule-feedback" aria-live="polite">
          {error
            ? <p id={errorId} className="agenda-error" role="alert">{error}</p>
            : (
              <p className="reschedule-hint">
                Se mantienen el paciente, el profesional y el tipo de sesión; solo cambian la fecha, la hora y la duración.
                {' '}{PENDING_REQUESTS_NOTICE}
                {browserZone !== timeZone && <> Horas en la zona horaria de la consulta ({timeZone}).</>}
              </p>
            )}
        </div>

        <div className="agenda-form-actions">
          <button type="button" className="small-secondary" onClick={onCancel} disabled={saving}>Cancelar</button>
          <button type="submit" className="primary-action" disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar cambio'}
          </button>
        </div>
      </form>
    </section>
  );
}
