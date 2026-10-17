'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type {
  PortalAppointmentRequestContract,
  PortalBookingAppointmentContract,
  PortalBookingOptionsContract,
  PortalSlotContract,
  PortalSlotsContract,
} from '@asepsico/contracts';
import { ApiError } from '@/lib/api';
import {
  bookingErrorMessage, EMERGENCY_FALLBACK, groupSlotsByDay, longDateTimeLabel, longDayLabel, monthGrid, monthLabel,
  monthsWithSlots, personName, PORTAL_STATUS_LABEL, PORTAL_TYPE_LABEL, portalStatusNote, STATUS_TONE, timeLabel,
} from '@/lib/booking';
import {
  portalCancel, portalCreate, portalOptions, portalRequests, portalReschedule, portalSlots, portalWithdraw,
} from '@/lib/booking-client';
import Icon, { EmptyState } from './Icon';

/*
 * "Pedir cita" en el portal del paciente.
 *
 * Si la reserva no está activa (o el paciente no tiene a nadie con quien reservar) NO se pinta
 * nada y no se explica por qué: la pantalla del portal queda como siempre. Los avisos al
 * paciente son genéricos; aquí solo se enseñan huecos libres (inicio y fin) y sus propias solicitudes.
 */

const WEEK_HEADER = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

/* ------------------------------------------------------------------------------------------ */
/* Selector de huecos: calendario del mes + horas del día                                      */
/* ------------------------------------------------------------------------------------------ */

type SlotPickerProps = {
  slots: PortalSlotContract[];
  timeZone?: string;
  selected: PortalSlotContract | null;
  onSelect: (slot: PortalSlotContract | null) => void;
};

export function SlotPicker({ slots, timeZone, selected, onSelect }: SlotPickerProps) {
  const byDay = useMemo(() => groupSlotsByDay(slots, timeZone), [slots, timeZone]);
  const dayKeys = Object.keys(byDay).sort();
  const months = useMemo(() => monthsWithSlots(dayKeys), [dayKeys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const [monthIndex, setMonthIndex] = useState(0);
  const [day, setDay] = useState<string | null>(null);
  const ids = useId();

  // Si los huecos cambian (p. ej. tras un 409), el mes y el día elegidos se ajustan a lo que queda.
  useEffect(() => {
    if (monthIndex > months.length - 1) setMonthIndex(Math.max(0, months.length - 1));
    if (day && !byDay[day]) setDay(null);
  }, [months.length, byDay, monthIndex, day]);

  const month = months[Math.min(monthIndex, Math.max(0, months.length - 1))];
  if (!month) return null;
  const weeks = monthGrid(month.year, month.month0);
  const daySlots = day ? byDay[day] ?? [] : [];

  return (
    <div className="bk-picker">
      <div className="bk-month-nav">
        <button type="button" className="bk-icon-button" onClick={() => setMonthIndex((i) => i - 1)} disabled={monthIndex <= 0} aria-label="Mes anterior">
          <Icon name="chevronLeft" size={18} />
        </button>
        <strong id={`${ids}-month`} aria-live="polite">{monthLabel(month.year, month.month0)}</strong>
        <button type="button" className="bk-icon-button" onClick={() => setMonthIndex((i) => i + 1)} disabled={monthIndex >= months.length - 1} aria-label="Mes siguiente">
          <Icon name="chevronRight" size={18} />
        </button>
      </div>

      <div className="bk-calendar" role="group" aria-labelledby={`${ids}-month`}>
        {WEEK_HEADER.map((letter, i) => <span key={letter + i} className="bk-weekday" aria-hidden="true">{letter}</span>)}
        {weeks.flat().map((key, i) => {
          if (!key) return <span key={`blank-${i}`} aria-hidden="true" />;
          const free = Boolean(byDay[key]);
          const number = Number(key.slice(8, 10));
          return (
            <button
              key={key}
              type="button"
              className={`bk-day${day === key ? ' is-selected' : ''}${free ? ' has-slots' : ''}`}
              disabled={!free}
              aria-pressed={free ? day === key : undefined}
              aria-label={free ? `${longDayLabel(key)}, hay horas libres` : `${longDayLabel(key)}, sin horas libres`}
              onClick={() => { setDay(key); onSelect(null); }}
            >
              {number}
            </button>
          );
        })}
      </div>

      {day && (
        <div className="bk-times" role="group" aria-label={`Horas libres el ${longDayLabel(day)}`}>
          <p className="bk-times-title">Horas libres el {longDayLabel(day)}</p>
          <div className="bk-time-grid">
            {daySlots.map((slot) => (
              <button
                key={slot.startsAt}
                type="button"
                className={`bk-time${selected?.startsAt === slot.startsAt ? ' is-selected' : ''}`}
                aria-pressed={selected?.startsAt === slot.startsAt}
                onClick={() => onSelect(slot)}
              >
                {timeLabel(slot.startsAt, timeZone)}
              </button>
            ))}
          </div>
        </div>
      )}
      {!day && <p className="bk-hint">Toca un día marcado para ver las horas libres.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Mis solicitudes                                                                             */
/* ------------------------------------------------------------------------------------------ */

type RequestsListProps = {
  requests: PortalAppointmentRequestContract[];
  appointments: PortalBookingAppointmentContract[];
  timeZone?: string;
  busy: boolean;
  onWithdraw: (request: PortalAppointmentRequestContract) => void;
};

export function RequestsList({ requests, appointments, timeZone, busy, onWithdraw }: RequestsListProps) {
  const [confirming, setConfirming] = useState<string | null>(null);

  if (!requests.length) {
    return <EmptyState icon="inbox" title="Todavía no has pedido ninguna cita" compact>Cuando pidas una, podrás ver aquí cómo va.</EmptyState>;
  }
  return (
    <ul className="bk-list">
      {requests.map((request) => {
        const original = request.sessionId ? appointments.find((a) => a.id === request.sessionId) : undefined;
        const note = portalStatusNote(request.status, request.type, request.rejectionReason);
        return (
          <li key={request.id} className="portal-item bk-request">
            <div className="bk-chips">
              <span className={`ui-chip ${STATUS_TONE[request.status]}`}>{PORTAL_STATUS_LABEL[request.status]}</span>
              <span className="bk-type">{PORTAL_TYPE_LABEL[request.type]}</span>
            </div>
            <strong>
              {request.type === 'CANCEL'
                ? original ? `Cita del ${longDateTimeLabel(original.startsAt, timeZone)}` : 'Una de tus citas'
                : request.startsAt ? longDateTimeLabel(request.startsAt, timeZone) : 'Hora por confirmar'}
            </strong>
            <span>Con {personName(request.therapist)}</span>
            {request.type === 'RESCHEDULE' && original && <span>Cita actual: {longDateTimeLabel(original.startsAt, timeZone)}</span>}
            {note && <span className="bk-note">{note}</span>}
            {request.status === 'PENDING' && (
              confirming === request.id ? (
                <div className="bk-inline-confirm" role="group" aria-label="Confirmar que quieres retirar la solicitud">
                  <span>¿Retirar esta solicitud?</span>
                  <button type="button" className="button secondary" disabled={busy} onClick={() => { setConfirming(null); onWithdraw(request); }}>Sí, retirarla</button>
                  <button type="button" className="bk-link-button" onClick={() => setConfirming(null)}>No, dejarla</button>
                </div>
              ) : (
                <button type="button" className="button secondary bk-small" disabled={busy} onClick={() => setConfirming(request.id)}>Retirar solicitud</button>
              )
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Panel (sin red: todo llega por props)                                                       */
/* ------------------------------------------------------------------------------------------ */

export type BookingPanelProps = {
  options: PortalBookingOptionsContract;
  requests: PortalAppointmentRequestContract[];
  slots: PortalSlotsContract | null;
  slotsState: 'loading' | 'ready' | 'error';
  therapistId: string;
  busy: boolean;
  notice: string;
  error: string;
  rescheduleOf: PortalBookingAppointmentContract | null;
  onTherapist: (id: string) => void;
  onStartReschedule: (appointment: PortalBookingAppointmentContract) => void;
  onStopReschedule: () => void;
  onSubmitSlot: (slot: PortalSlotContract) => void;
  onCancelAppointment: (appointment: PortalBookingAppointmentContract) => void;
  onWithdraw: (request: PortalAppointmentRequestContract) => void;
  onRetrySlots: () => void;
};

export function BookingPanel(props: BookingPanelProps) {
  const { options, requests, slots, slotsState, therapistId, busy, notice, error, rescheduleOf } = props;
  const [selected, setSelected] = useState<PortalSlotContract | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const ids = useId();

  // Un cambio de profesional, de modo o de huecos descarta la hora elegida.
  useEffect(() => { setSelected(null); }, [therapistId, rescheduleOf?.id, slots]);

  // Reserva no activa: nada en pantalla y ninguna explicación.
  if (!options.canBook) return null;

  const timeZone = slots?.timeZone;
  const therapist = options.therapists.find((t) => t.id === therapistId) ?? options.therapists[0];
  const emergency = options.emergencyNotice || EMERGENCY_FALLBACK;
  const reschedulable = options.appointments;

  return (
    <div className="bk-portal-wrap">
      <article className="portal-card bk-card" aria-labelledby={`${ids}-title`}>
        <h2 className="portal-card-title" id={`${ids}-title`}>
          <span className="portal-card-icon"><Icon name="calendar" size={18} /></span>
          {rescheduleOf ? 'Cambiar tu cita' : 'Pedir cita'}
        </h2>
        <p className="portal-card-intro">
          {rescheduleOf
            ? `Elige la nueva hora para tu cita del ${longDateTimeLabel(rescheduleOf.startsAt, timeZone)}. Tu cita actual sigue en pie hasta que tu profesional confirme el cambio.`
            : 'Elige el día y la hora que mejor te vengan. Tu profesional lo revisará y te confirmará la cita.'}
        </p>

        {notice && <p className="patient-save-state" role="status">{notice}</p>}
        {error && <p className="agenda-error" role="alert">{error}</p>}

        {rescheduleOf && (
          <button type="button" className="bk-link-button bk-stop" onClick={props.onStopReschedule}>
            <Icon name="arrowLeft" size={16} />Dejar mi cita como está
          </button>
        )}

        {options.therapists.length > 1 && !rescheduleOf && (
          <label className="field bk-field">
            ¿Con quién quieres pedir cita?
            <select value={therapist?.id ?? ''} onChange={(event) => props.onTherapist(event.target.value)} disabled={busy}>
              {options.therapists.map((t) => <option key={t.id} value={t.id}>{personName(t)}</option>)}
            </select>
          </label>
        )}
        {(options.therapists.length === 1 || rescheduleOf) && therapist && (
          <p className="bk-with"><Icon name="users" size={16} />Con {personName(rescheduleOf ? rescheduleOf.therapist : therapist)}</p>
        )}

        {slotsState === 'loading' && <p className="portal-loading" role="status">Buscando horas libres…</p>}
        {slotsState === 'error' && (
          <div className="bk-retry">
            <p>No hemos podido cargar las horas libres.</p>
            <button type="button" className="button secondary" onClick={props.onRetrySlots}>Intentar de nuevo</button>
          </div>
        )}
        {slotsState === 'ready' && slots && slots.slots.length === 0 && (
          <EmptyState icon="clock" title="Ahora mismo no hay horas libres" compact>
            Vuelve a mirar dentro de unos días o contacta con la consulta.
          </EmptyState>
        )}
        {slotsState === 'ready' && slots && slots.slots.length > 0 && (
          <SlotPicker slots={slots.slots} timeZone={timeZone} selected={selected} onSelect={setSelected} />
        )}

        {selected && (
          <div className="bk-confirm" role="group" aria-label="Confirmar tu solicitud">
            <p>
              {rescheduleOf ? 'Vas a pedir cambiar tu cita al ' : 'Vas a pedir cita para el '}
              <strong>{longDateTimeLabel(selected.startsAt, timeZone)}</strong>.
            </p>
            <p className="bk-hint">Hasta que la consulta lo confirme, la cita no está reservada.</p>
            <div className="bk-actions">
              <button type="button" className="button" disabled={busy} onClick={() => props.onSubmitSlot(selected)}>
                {busy ? 'Enviando…' : rescheduleOf ? 'Pedir el cambio' : 'Enviar solicitud'}
              </button>
              <button type="button" className="button secondary" disabled={busy} onClick={() => setSelected(null)}>Elegir otra hora</button>
            </div>
          </div>
        )}

        <p className="bk-emergency"><Icon name="info" size={16} /><span>{emergency}</span></p>
      </article>

      <div className="bk-side">
        {reschedulable.length > 0 && !rescheduleOf && (
          <article className="portal-card bk-card">
            <h2 className="portal-card-title"><span className="portal-card-icon"><Icon name="clock" size={18} /></span>Cambiar o cancelar una cita</h2>
            <ul className="bk-list">
              {reschedulable.map((appointment) => (
                <li key={appointment.id} className="portal-item">
                  <strong>{longDateTimeLabel(appointment.startsAt, timeZone)}</strong>
                  <span>Con {personName(appointment.therapist)}</span>
                  {appointment.hasPendingRequest && <span className="ui-chip chip-amber">Solicitud en curso</span>}
                  {appointment.changeAllowed && (
                    confirmCancel === appointment.id ? (
                      <div className="bk-inline-confirm" role="group" aria-label="Confirmar la cancelación">
                        <span>¿Pedir que se cancele esta cita?</span>
                        <button type="button" className="button secondary" disabled={busy} onClick={() => { setConfirmCancel(null); props.onCancelAppointment(appointment); }}>Sí, pedir cancelación</button>
                        <button type="button" className="bk-link-button" onClick={() => setConfirmCancel(null)}>No, mantenerla</button>
                      </div>
                    ) : (
                      <div className="bk-actions">
                        <button type="button" className="button secondary bk-small" disabled={busy} onClick={() => props.onStartReschedule(appointment)}>Pedir otro día u hora</button>
                        <button type="button" className="button secondary bk-small" disabled={busy} onClick={() => setConfirmCancel(appointment.id)}>Pedir cancelación</button>
                      </div>
                    )
                  )}
                  {!appointment.changeAllowed && !appointment.hasPendingRequest && (
                    <span className="bk-note">Falta poco para esta cita. Si necesitas cambiarla, llama a la consulta.</span>
                  )}
                </li>
              ))}
            </ul>
          </article>
        )}

        <article className="portal-card bk-card">
          <h2 className="portal-card-title"><span className="portal-card-icon"><Icon name="inbox" size={18} /></span>Mis solicitudes</h2>
          <RequestsList requests={requests} appointments={options.appointments} timeZone={timeZone} busy={busy} onWithdraw={props.onWithdraw} />
        </article>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Contenedor: carga de datos y acciones                                                       */
/* ------------------------------------------------------------------------------------------ */

type Loaded = { options: PortalBookingOptionsContract; requests: PortalAppointmentRequestContract[] };

export default function PortalBooking() {
  const [data, setData] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [therapistId, setTherapistId] = useState('');
  const [slots, setSlots] = useState<PortalSlotsContract | null>(null);
  const [slotsState, setSlotsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rescheduleOf, setRescheduleOf] = useState<PortalBookingAppointmentContract | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const loadAll = useCallback(async () => {
    try {
      const options = await portalOptions();
      const requests = options.canBook ? await portalRequests() : [];
      setData({ options, requests });
      setLoadFailed(false);
      setTherapistId((current) => (options.therapists.some((t) => t.id === current) ? current : options.therapists[0]?.id ?? ''));
    } catch (err) {
      // 401: la pantalla del portal ya lleva al inicio de sesión. Otros fallos: aviso discreto.
      if (!(err instanceof ApiError && (err.status === 401 || err.status === 404))) setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const activeTherapist = rescheduleOf?.therapist.id ?? therapistId;
  const canBook = Boolean(data?.options.canBook);

  const loadSlots = useCallback(async (id: string) => {
    setSlotsState('loading');
    try {
      setSlots(await portalSlots(id));
      setSlotsState('ready');
    } catch {
      setSlotsState('error');
    }
  }, []);

  useEffect(() => {
    if (canBook && activeTherapist) void loadSlots(activeTherapist);
  }, [canBook, activeTherapist, loadSlots]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await action();
      setNotice(success);
      setRescheduleOf(null);
      await loadAll();
      if (activeTherapist) await loadSlots(activeTherapist);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      const code = err instanceof ApiError ? err.code : undefined;
      setError(bookingErrorMessage(status, code, err instanceof Error ? err.message : ''));
      // Hueco ocupado o solicitud ya resuelta: se refresca lo que ve la persona.
      if (code === 'SLOT_NOT_AVAILABLE' && activeTherapist) await loadSlots(activeTherapist);
      await loadAll();
    } finally {
      setBusy(false);
    }
  }

  if (loadFailed && !data) {
    return (
      <div className="bk-portal-wrap">
        <article className="portal-card bk-card">
          <p className="agenda-error" role="alert">No hemos podido cargar la opción de pedir cita.</p>
          <button type="button" className="button secondary" onClick={() => void loadAll()}>Intentar de nuevo</button>
        </article>
      </div>
    );
  }
  if (!data || !data.options.canBook) return null;

  return (
    <BookingPanel
      options={data.options}
      requests={data.requests}
      slots={slots}
      slotsState={slotsState}
      therapistId={therapistId}
      busy={busy}
      notice={notice}
      error={error}
      rescheduleOf={rescheduleOf}
      onTherapist={(id) => { setTherapistId(id); setError(''); setNotice(''); }}
      onStartReschedule={(a) => { setRescheduleOf(a); setError(''); setNotice(''); }}
      onStopReschedule={() => { setRescheduleOf(null); setError(''); }}
      onSubmitSlot={(slot) => run(
        () => (rescheduleOf ? portalReschedule(rescheduleOf.id, slot.startsAt) : portalCreate(activeTherapist, slot.startsAt)),
        rescheduleOf ? 'Petición enviada. Tu cita actual sigue en pie hasta que la consulta confirme el cambio.' : 'Solicitud enviada. La consulta te confirmará la cita.',
      )}
      onCancelAppointment={(a) => run(() => portalCancel(a.id), 'Petición enviada. Tu cita sigue en pie hasta que la consulta responda.')}
      onWithdraw={(r) => run(() => portalWithdraw(r.id), 'Has retirado tu solicitud.')}
      onRetrySlots={() => activeTherapist && void loadSlots(activeTherapist)}
    />
  );
}
