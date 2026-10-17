'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AvailabilityBlockContract, AvailabilityViewContract, AvailabilityWindowContract, BLOCK_REASONS, BlockReason,
} from '@asepsico/contracts';
import Sidebar from '@/components/Sidebar';
import WeeklyWindows from '@/components/WeeklyWindows';
import PortalBookingToggle from '@/components/PortalBookingToggle';
import Icon, { EmptyState } from '@/components/Icon';
import { api } from '@/lib/api';
import {
  BLOCK_REASON_LABEL, blockFormToRange, canToggleBooking, COMMON_TIME_ZONES, formatBlockRange, isValidTimeZone, validateWindows,
} from '@/lib/booking';
import {
  createBlock, deleteBlock, getAvailability, saveAvailability, setPortalBooking, setTimeZone,
} from '@/lib/booking-client';
import { isAdminRole, isForbidden, useViewer } from '@/lib/clinical';

type Professional = { id: string; name: string };
type Settings = { sessionMinutes: number; breakMinutes: number; minNoticeHours: number; maxHorizonDays: number; cancelNoticeHours: number; maxPendingPerPatient: number };
type Draft = Settings & { windows: AvailabilityWindowContract[] };

const pick = (view: AvailabilityViewContract): Draft => ({
  sessionMinutes: view.settings.sessionMinutes,
  breakMinutes: view.settings.breakMinutes,
  minNoticeHours: view.settings.minNoticeHours,
  maxHorizonDays: view.settings.maxHorizonDays,
  cancelNoticeHours: view.settings.cancelNoticeHours,
  maxPendingPerPatient: view.settings.maxPendingPerPatient,
  windows: view.windows.map((w) => ({ weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute })),
});

const normalize = (draft: Draft) => JSON.stringify({ ...draft, windows: [...draft.windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute) });

/** Lista de opciones; si el valor guardado no está (p. ej. 35 min), se añade para no perderlo. */
function withValue(values: number[], current: number) {
  return values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
}

const SESSION_MINUTES = [30, 40, 45, 50, 55, 60, 75, 90, 120];
const BREAK_MINUTES = [0, 5, 10, 15, 20, 30, 45, 60];
const MIN_NOTICE = [2, 4, 12, 24, 48, 72, 168];
const HORIZON = [7, 14, 21, 28, 42, 60];
const CANCEL_NOTICE = [0, 2, 12, 24, 48, 72];

function personLabel(p: { firstName?: string | null; lastName?: string | null; email?: string | null }) {
  return [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || p.email || 'Profesional';
}

/**
 * "Mi disponibilidad": franjas semanales, duración, descanso, antelaciones y bloqueos de un
 * profesional, y el interruptor para que sus pacientes pidan cita desde el portal (desactivado por
 * defecto). Un terapeuta edita la suya; titular, administración y recepción eligen al profesional.
 * Recepción puede ajustar franjas y bloqueos, pero no activar ni desactivar la reserva.
 */
export default function AvailabilityPage() {
  const viewer = useViewer();
  const role = viewer?.role ?? null;
  const [professionals, setProfessionals] = useState<Professional[] | null>(null);
  const [therapistId, setTherapistId] = useState('');
  const [view, setView] = useState<AvailabilityViewContract | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState('');
  const [blocks, setBlocks] = useState<AvailabilityBlockContract[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden' | 'empty'>('loading');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Quién puede elegirse: el propio terapeuta; titular y administración, el equipo clínico;
  // recepción, los profesionales con citas en la agenda (la API no tiene aún un listado propio).
  useEffect(() => {
    if (!viewer?.role) return;
    let cancelled = false;
    (async () => {
      try {
        let list: Professional[] = [];
        if (viewer.role === 'THERAPIST' && viewer.userId) {
          list = [{ id: viewer.userId, name: personLabel(viewer) }];
        } else if (isAdminRole(viewer.role)) {
          const members = await api<{ userId: string; role: string; isClinician: boolean; firstName: string | null; lastName: string | null; email: string | null }[]>('/workspace-members');
          list = members.filter((m) => m.isClinician || m.role === 'THERAPIST').map((m) => ({ id: m.userId, name: personLabel(m) }));
        } else {
          const day = 86_400_000;
          const from = new Date(Date.now() - 30 * day).toISOString();
          const to = new Date(Date.now() + 90 * day).toISOString();
          const page = await api<{ data: { therapist?: { id: string; firstName: string; lastName: string } | null }[] }>(`/sessions?from=${from}&to=${to}&pageSize=100`);
          const seen = new Map<string, Professional>();
          for (const s of page.data) if (s.therapist && !seen.has(s.therapist.id)) seen.set(s.therapist.id, { id: s.therapist.id, name: personLabel(s.therapist) });
          list = [...seen.values()];
        }
        if (cancelled) return;
        setProfessionals(list);
        const own = list.find((p) => p.id === viewer.userId);
        setTherapistId((own ?? list[0])?.id ?? '');
        if (!list.length) setState('empty');
      } catch (err) {
        if (cancelled) return;
        if (isForbidden(err)) setState('forbidden');
        else { setError(err instanceof Error && err.message ? err.message : 'No se pudo cargar el equipo.'); setState('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [viewer]);

  const load = useCallback(async (id: string) => {
    setState('loading'); setError(''); setStatus('');
    try {
      const result = await getAvailability(id);
      setView(result);
      setDraft(pick(result));
      setBlocks(result.blocks);
      setState('ready');
    } catch (err) {
      if (isForbidden(err)) { setState('forbidden'); return; }
      setError(err instanceof Error && err.message ? err.message : 'No se pudo cargar la disponibilidad.');
      setState('error');
    }
  }, []);

  useEffect(() => { if (therapistId) void load(therapistId); }, [therapistId, load]);

  const dirty = useMemo(() => Boolean(view && draft && normalize(draft) !== normalize(pick(view))), [view, draft]);
  const professional = professionals?.find((p) => p.id === therapistId);
  const isSelf = therapistId === viewer?.userId;
  const canToggle = canToggleBooking(role, isSelf);
  const timeZone = view?.timeZone ?? 'Europe/Madrid';

  // Aviso del navegador si hay cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function patchDraft(patch: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setSaved('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !therapistId) return;
    const invalid = validateWindows(draft.windows);
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(''); setSaved('');
    try {
      const result = await saveAvailability(therapistId, draft);
      setView(result);
      setDraft(pick(result));
      setBlocks(result.blocks);
      setSaved('Disponibilidad guardada.');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'No se pudo guardar la disponibilidad.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleBooking(enabled: boolean) {
    if (!view) return;
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await setPortalBooking(therapistId, enabled);
      setView({ ...view, settings: { ...view.settings, portalBookingEnabled: result.settings.portalBookingEnabled } });
      setStatus(enabled ? 'Reserva desde el portal activada.' : 'Reserva desde el portal desactivada.');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'No se pudo cambiar la reserva desde el portal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="dashboard">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">AGENDA</p>
            <h1>{role === 'THERAPIST' ? 'Mi disponibilidad' : 'Disponibilidad'}</h1>
            <p className="dashboard-subtitle">Cuándo se puede pedir cita. Los pacientes solo ven las horas libres, nunca tu agenda.</p>
          </div>
          <div className="dashboard-actions">
            <Link href="/agenda" className="agenda-navigation-button"><Icon name="arrowLeft" size={18} />Agenda</Link>
            <Link href="/agenda/solicitudes" className="primary-action"><Icon name="inbox" size={18} />Solicitudes de cita</Link>
          </div>
        </header>

        {professionals && professionals.length > 1 && (
          <label className="field bk-field bk-picker-select">
            Profesional
            <select value={therapistId} onChange={(e) => { if (!dirty || window.confirm('Tienes cambios sin guardar. ¿Quieres descartarlos?')) setTherapistId(e.target.value); }}>
              {professionals.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === viewer?.userId ? ' (tú)' : ''}</option>)}
            </select>
          </label>
        )}

        <p className={status ? 'patient-save-state' : 'bk-live'} role="status" aria-live="polite">{status}</p>
        {error && <div className="agenda-error" role="alert">{error}</div>}

        {state === 'loading' && <section className="dashboard-card dashboard-loading" role="status">Cargando disponibilidad…</section>}
        {state === 'forbidden' && <section className="dashboard-card"><EmptyState icon="lock" title="Sin acceso a esta sección">No puedes gestionar la disponibilidad de este profesional.</EmptyState></section>}
        {state === 'empty' && (
          <section className="dashboard-card">
            <EmptyState icon="users" title="Todavía no hay profesionales con agenda">
              {role === 'ASSISTANT'
                ? 'Aparecerán aquí en cuanto tengan una cita en la agenda.'
                : 'Marca como profesional clínico a quien atienda pacientes desde Equipo.'}
            </EmptyState>
          </section>
        )}
        {state === 'error' && (
          <section className="dashboard-card dashboard-error" role="alert">
            <p>{error || 'No se pudo cargar la disponibilidad.'}</p>
            <button type="button" className="button secondary" onClick={() => (therapistId ? void load(therapistId) : window.location.reload())}>Intentar de nuevo</button>
          </section>
        )}

        {state === 'ready' && view && draft && (
          <>
            <PortalBookingToggle
              canToggle={canToggle}
              isSelf={isSelf}
              professionalName={professional?.name}
              enabled={view.settings.portalBookingEnabled}
              hasWindows={draft.windows.length > 0}
              busy={busy}
              onToggle={(enabled) => void toggleBooking(enabled)}
            />

            <form onSubmit={save} noValidate>
              <section className="dashboard-card bk-section" aria-labelledby="bk-windows-title">
                <h2 id="bk-windows-title">Franjas de consulta</h2>
                <p className="bk-hint">Horas en la zona horaria de la consulta ({timeZone}). Para un descanso, parte la franja en dos.</p>
                <WeeklyWindows windows={draft.windows} onChange={(windows) => patchDraft({ windows })} disabled={busy} />
              </section>

              <section className="dashboard-card bk-section" aria-labelledby="bk-settings-title">
                <h2 id="bk-settings-title">Sesiones y plazos</h2>
                <div className="bk-settings-grid">
                  <label className="field bk-field">Duración de cada sesión
                    <select value={draft.sessionMinutes} onChange={(e) => patchDraft({ sessionMinutes: Number(e.target.value) })}>
                      {withValue(SESSION_MINUTES, draft.sessionMinutes).map((v) => <option key={v} value={v}>{v} minutos</option>)}
                    </select>
                  </label>
                  <label className="field bk-field">Descanso entre sesiones
                    <select value={draft.breakMinutes} onChange={(e) => patchDraft({ breakMinutes: Number(e.target.value) })}>
                      {withValue(BREAK_MINUTES, draft.breakMinutes).map((v) => <option key={v} value={v}>{v === 0 ? 'Sin descanso' : `${v} minutos`}</option>)}
                    </select>
                  </label>
                  <label className="field bk-field">Antelación mínima para pedir cita
                    <select value={draft.minNoticeHours} onChange={(e) => patchDraft({ minNoticeHours: Number(e.target.value) })}>
                      {withValue(MIN_NOTICE, draft.minNoticeHours).map((v) => <option key={v} value={v}>{v} horas</option>)}
                    </select>
                  </label>
                  <label className="field bk-field">Hasta cuántos días vista se puede pedir
                    <select value={draft.maxHorizonDays} onChange={(e) => patchDraft({ maxHorizonDays: Number(e.target.value) })}>
                      {withValue(HORIZON, draft.maxHorizonDays).map((v) => <option key={v} value={v}>{v} días</option>)}
                    </select>
                  </label>
                  <label className="field bk-field">Plazo para pedir cambio o cancelación
                    <select value={draft.cancelNoticeHours} onChange={(e) => patchDraft({ cancelNoticeHours: Number(e.target.value) })}>
                      {withValue(CANCEL_NOTICE, draft.cancelNoticeHours).map((v) => <option key={v} value={v}>{v === 0 ? 'Hasta el último momento' : `${v} horas antes`}</option>)}
                    </select>
                  </label>
                  <label className="field bk-field">Solicitudes pendientes por paciente
                    <select value={draft.maxPendingPerPatient} onChange={(e) => patchDraft({ maxPendingPerPatient: Number(e.target.value) })}>
                      {[1, 2, 3].map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </label>
                </div>
              </section>

              <div className="bk-savebar">
                <button type="submit" className="button" disabled={busy || !dirty}>{busy ? 'Guardando…' : 'Guardar disponibilidad'}</button>
                <span className="bk-save-state" role="status" aria-live="polite">{dirty ? 'Tienes cambios sin guardar.' : saved}</span>
              </div>
            </form>

            <BlocksSection
              therapistId={therapistId}
              timeZone={timeZone}
              blocks={blocks}
              onBlocks={setBlocks}
              onError={setError}
            />

            <TimeZoneSection
              timeZone={timeZone}
              canEdit={isAdminRole(role)}
              dirty={dirty}
              onSaved={(tz) => { setView((current) => (current ? { ...current, timeZone: tz } : current)); setStatus('Zona horaria actualizada.'); }}
              onError={setError}
            />
          </>
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

function BlocksSection({ therapistId, timeZone, blocks, onBlocks, onError }: {
  therapistId: string; timeZone: string; blocks: AvailabilityBlockContract[];
  onBlocks: (blocks: AvailabilityBlockContract[]) => void; onError: (message: string) => void;
}) {
  const [reason, setReason] = useState<BlockReason>('VACATION');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [allDay, setAllDay] = useState(true);
  const [fromTime, setFromTime] = useState('09:00');
  const [toTime, setToTime] = useState('14:00');
  const [formError, setFormError] = useState('');
  const [warning, setWarning] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(event: FormEvent) {
    event.preventDefault();
    const range = blockFormToRange({ fromDate, toDate: toDate || fromDate, allDay, fromTime, toTime }, timeZone);
    if ('error' in range) { setFormError(range.error); return; }
    setBusy(true); setFormError(''); setWarning(''); onError('');
    try {
      const result = await createBlock(therapistId, { ...range, reason });
      onBlocks([...blocks, result.block].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
      setWarning(result.warning ?? 'Bloqueo guardado.');
      setFromDate(''); setToDate('');
    } catch (err) {
      setFormError(err instanceof Error && err.message ? err.message : 'No se pudo guardar el bloqueo.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(block: AvailabilityBlockContract) {
    setBusy(true); setWarning(''); onError('');
    try {
      await deleteBlock(therapistId, block.id);
      onBlocks(blocks.filter((b) => b.id !== block.id));
      setWarning('Bloqueo quitado.');
    } catch (err) {
      onError(err instanceof Error && err.message ? err.message : 'No se pudo quitar el bloqueo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dashboard-card bk-section" aria-labelledby="bk-blocks-title">
      <h2 id="bk-blocks-title">Bloqueos</h2>
      <p className="bk-hint">Días u horas en los que no se ofrecen citas: vacaciones, formación… Las citas que ya tengas en esas fechas no se cancelan solas.</p>

      {blocks.length === 0 ? (
        <EmptyState icon="calendar" title="No tienes bloqueos próximos" compact>Añade uno cuando te vayas de vacaciones o tengas formación.</EmptyState>
      ) : (
        <ul className="bk-blocks">
          {blocks.map((block) => {
            const range = formatBlockRange(block.startsAt, block.endsAt, timeZone);
            return (
              <li key={block.id}>
                <span className="ui-chip chip-violet">{BLOCK_REASON_LABEL[block.reason]}</span>
                <span className="bk-block-range">{range}</span>
                <button type="button" className="bk-link-button" disabled={busy} aria-label={`Quitar el bloqueo: ${BLOCK_REASON_LABEL[block.reason]}, ${range}`} onClick={() => void remove(block)}>Quitar</button>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={add} className="bk-block-form" noValidate>
        <h3>Añadir un bloqueo</h3>
        <div className="bk-settings-grid">
          <label className="field bk-field">Motivo
            <select value={reason} onChange={(e) => setReason(e.target.value as BlockReason)}>
              {BLOCK_REASONS.map((r) => <option key={r} value={r}>{BLOCK_REASON_LABEL[r]}</option>)}
            </select>
          </label>
          <label className="field bk-field">Desde el día
            <input type="date" value={fromDate} required onChange={(e) => { setFromDate(e.target.value); if (!toDate || toDate < e.target.value) setToDate(e.target.value); }} />
          </label>
          <label className="field bk-field">Hasta el día (incluido)
            <input type="date" value={toDate} min={fromDate || undefined} required onChange={(e) => setToDate(e.target.value)} />
          </label>
        </div>
        <label className="bk-check">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          <span>Todo el día</span>
        </label>
        {!allDay && (
          <div className="bk-settings-grid">
            <label className="field bk-field">De las
              <input type="time" step={900} value={fromTime} onChange={(e) => setFromTime(e.target.value)} />
            </label>
            <label className="field bk-field">A las
              <input type="time" step={900} value={toTime} onChange={(e) => setToTime(e.target.value)} />
            </label>
          </div>
        )}
        {formError && <p className="agenda-error" role="alert">{formError}</p>}
        {warning && <p className={warning.startsWith('Hay ') ? 'e1-notice info bk-warn' : 'patient-save-state'} role="status">{warning}</p>}
        <button type="submit" className="button secondary" disabled={busy}>Añadir bloqueo</button>
      </form>
    </section>
  );
}

function TimeZoneSection({ timeZone, canEdit, dirty, onSaved, onError }: {
  timeZone: string; canEdit: boolean; dirty: boolean; onSaved: (tz: string) => void; onError: (message: string) => void;
}) {
  const [value, setValue] = useState(timeZone);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(timeZone), [timeZone]);
  const options = useMemo(() => (COMMON_TIME_ZONES as readonly string[]).includes(timeZone) ? [...COMMON_TIME_ZONES] : [timeZone, ...COMMON_TIME_ZONES], [timeZone]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isValidTimeZone(value)) { onError('Zona horaria no válida.'); return; }
    if (dirty && !window.confirm('Tienes cambios sin guardar en las franjas. Cambiar la zona horaria no los guarda. ¿Continuar?')) return;
    setBusy(true); onError('');
    try {
      const result = await setTimeZone(value);
      onSaved(result.timeZone);
    } catch (err) {
      onError(err instanceof Error && err.message ? err.message : 'No se pudo cambiar la zona horaria.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dashboard-card bk-section" aria-labelledby="bk-tz-title">
      <h2 id="bk-tz-title">Zona horaria de la consulta</h2>
      {canEdit ? (
        <form onSubmit={submit} className="bk-tz-form">
          <label className="field bk-field">Zona horaria
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              {options.map((tz) => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <p className="bk-hint">Es la misma para toda la consulta. Las franjas se leen en esta zona; si la cambias, las horas ofrecidas se desplazan.</p>
          <button type="submit" className="button secondary" disabled={busy || value === timeZone}>{busy ? 'Guardando…' : 'Guardar zona horaria'}</button>
        </form>
      ) : (
        <p className="bk-hint">{timeZone.replace(/_/g, ' ')}. Solo la persona titular o administración pueden cambiarla.</p>
      )}
    </section>
  );
}
