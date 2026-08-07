'use client';

import {
  FormEvent,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../components/Sidebar';
import { api } from '@/lib/api';

type TherapyModality =
  | 'IN_PERSON'
  | 'ONLINE'
  | 'HYBRID';

type SessionType =
  | 'INDIVIDUAL'
  | 'COUPLE'
  | 'FAMILY'
  | 'GROUP'
  | 'FOLLOW_UP'
  | 'ASSESSMENT';

type ClinicalProcessSummary = {
  id: string;
  title: string;
  modality: TherapyModality;
  status: 'ACTIVE';
};

type Patient = {
  id: string;
  firstName: string;
  lastName: string;
  summary?: {
    activeProcess: ClinicalProcessSummary | null;
  };
};

type SessionStatus =
  | 'SCHEDULED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

type Session = {
  id: string;
  patientId: string;
  therapistId: string;
  clinicalProcessId?: string | null;
  startsAt: string;
  endsAt: string;
  status: SessionStatus;
  type: SessionType;
  location?: string | null;
  videoCallUrl?: string | null;
  notes?: string | null;

  patient?: {
    id: string;
    firstName: string;
    lastName: string;
  };

  therapist?: {
    id: string;
    firstName: string;
    lastName: string;
  };

  clinicalProcess?: {
    id: string;
    title: string;
    modality: TherapyModality;
    status: string;
  } | null;
};

type Page<T> = {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

const STATUS_LABELS: Record<SessionStatus, string> = {
  SCHEDULED: 'Programada',
  COMPLETED: 'Completada',
  CANCELLED: 'Cancelada',
  NO_SHOW: 'No asistió',
};

const TYPE_LABELS: Record<SessionType, string> = {
  INDIVIDUAL: 'Individual',
  COUPLE: 'Pareja',
  FAMILY: 'Familiar',
  GROUP: 'Grupal',
  FOLLOW_UP: 'Seguimiento',
  ASSESSMENT: 'Evaluación',
};

const MODALITY_LABELS: Record<TherapyModality, string> = {
  IN_PERSON: 'Presencial',
  ONLINE: 'Online',
  HYBRID: 'Híbrida',
};

function startOfWeek(date: Date) {
  const result = new Date(date);
  const day = result.getDay();
  const difference = day === 0 ? -6 : 1 - day;

  result.setDate(result.getDate() + difference);
  result.setHours(0, 0, 0, 0);

  return result;
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);

  return result;
}

function formatDateForInput(date: Date) {
  const pad = (value: number) =>
    String(value).padStart(2, '0');

  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('');
}

function sameDay(firstDate: Date, secondDate: Date) {
  return (
    firstDate.getFullYear() === secondDate.getFullYear() &&
    firstDate.getMonth() === secondDate.getMonth() &&
    firstDate.getDate() === secondDate.getDate()
  );
}

function formatTime(date: string) {
  return new Date(date).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startsAt: string, endsAt: string) {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();

  const minutes = Math.max(
    0,
    Math.round((end - start) / 60000),
  );

  return `${minutes} min`;
}

export default function AgendaPage() {
  const router = useRouter();

  const [patients, setPatients] = useState<Patient[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);

  const [selectedPatientId, setSelectedPatientId] =
    useState('');

  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date()),
  );

  const [newSessionOpen, setNewSessionOpen] =
    useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] =
    useState('');

  const weekEnd = useMemo(
    () => addDays(weekStart, 7),
    [weekStart],
  );

  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) =>
        addDays(weekStart, index),
      ),
    [weekStart],
  );

  const selectedPatient =
    patients.find(
      (patient) => patient.id === selectedPatientId,
    ) ?? null;

  const activeProcess =
    selectedPatient?.summary?.activeProcess ?? null;

  async function loadAgenda() {
    try {
      setLoading(true);
      setError('');

      const [patientsPage, sessionsPage] =
        await Promise.all([
          api<Page<Patient>>(
            '/patients?status=ACTIVE&pageSize=100',
          ),
          api<Page<Session>>(
            `/sessions?from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}&pageSize=100`,
          ),
        ]);

      setPatients(patientsPage.data);
      setSessions(sessionsPage.data);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'No se pudo cargar la agenda.',
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAgenda();
  }, [weekStart, weekEnd]);

  function getPatientName(session: Session) {
    if (session.patient) {
      return `${session.patient.firstName} ${session.patient.lastName}`;
    }

    const patient = patients.find(
      (currentPatient) =>
        currentPatient.id === session.patientId,
    );

    if (!patient) {
      return 'Paciente';
    }

    return `${patient.firstName} ${patient.lastName}`;
  }

  function getPatientInitials(session: Session) {
    const patient = patients.find(
      (currentPatient) =>
        currentPatient.id === session.patientId,
    );

    const firstName =
      session.patient?.firstName ??
      patient?.firstName;

    const lastName =
      session.patient?.lastName ??
      patient?.lastName;

    if (!firstName && !lastName) {
      return 'P';
    }

    const firstInitial =
      firstName?.charAt(0).toUpperCase() ?? '';

    const lastInitial =
      lastName?.charAt(0).toUpperCase() ?? '';

    return `${firstInitial}${lastInitial}` || 'P';
  }

  function sessionsForDay(day: Date) {
    return sessions
      .filter((session) =>
        sameDay(new Date(session.startsAt), day),
      )
      .sort(
        (firstSession, secondSession) =>
          new Date(firstSession.startsAt).getTime() -
          new Date(secondSession.startsAt).getTime(),
      );
  }

  function closeNewSessionForm() {
    setNewSessionOpen(false);
    setSelectedPatientId('');
    setError('');
    setSuccessMessage('');
  }

  async function createSession(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);

    const startsAtValue = String(
      formData.get('startsAt') || '',
    );

    const patientId = String(
      formData.get('patientId') || '',
    );

    const duration = Number(
      formData.get('duration') || 50,
    );

    const sessionType = String(
      formData.get('type') || 'INDIVIDUAL',
    ) as SessionType;

    if (!patientId) {
      setError('Selecciona un paciente.');
      return;
    }

    if (!startsAtValue) {
      setError(
        'Selecciona la fecha y hora de inicio.',
      );
      return;
    }

    if (
      Number.isNaN(duration) ||
      duration <= 0
    ) {
      setError(
        'La duración de la sesión no es válida.',
      );
      return;
    }

    const patient = patients.find(
      (item) => item.id === patientId,
    );

    if (!patient) {
      setError(
        'El paciente seleccionado no es válido.',
      );
      return;
    }

    const process =
      patient.summary?.activeProcess ?? null;

    const startsAt = new Date(startsAtValue);

    if (Number.isNaN(startsAt.getTime())) {
      setError(
        'La fecha de inicio no es válida.',
      );
      return;
    }

    const endsAt = new Date(
      startsAt.getTime() +
        duration * 60 * 1000,
    );

    const location = String(
      formData.get('location') || '',
    ).trim();

    const videoCallUrl = String(
      formData.get('videoCallUrl') || '',
    ).trim();

    const notes = String(
      formData.get('notes') || '',
    ).trim();

    const payload: {
      patientId: string;
      clinicalProcessId?: string;
      startsAt: string;
      endsAt: string;
      type: SessionType;
      location?: string;
      videoCallUrl?: string;
      notes?: string;
    } = {
      patientId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      type: sessionType,
    };

    if (process?.id) {
      payload.clinicalProcessId = process.id;
    }

    if (location) {
      payload.location = location;
    }

    if (videoCallUrl) {
      payload.videoCallUrl = videoCallUrl;
    }

    if (notes) {
      payload.notes = notes;
    }

    try {
      setSaving(true);
      setError('');
      setSuccessMessage('');

      await api('/sessions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      form.reset();
      setSelectedPatientId('');
      setNewSessionOpen(false);
      setSuccessMessage(
        'La sesión se ha creado correctamente.',
      );

      await loadAgenda();
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'No se pudo crear la sesión.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function closeSession(
    sessionId: string,
    status: 'COMPLETED' | 'CANCELLED' | 'NO_SHOW',
  ) {
    try {
      setError('');
      setSuccessMessage('');

      await api(`/sessions/${sessionId}/close`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });

      setSuccessMessage(
        'La sesión se ha actualizado correctamente.',
      );

      await loadAgenda();
    } catch (closeError) {
      setError(
        closeError instanceof Error
          ? closeError.message
          : 'No se pudo actualizar la sesión.',
      );
    }
  }

  const weekLabel = `${weekStart.toLocaleDateString(
    'es-ES',
    {
      day: 'numeric',
      month: 'long',
    },
  )} – ${addDays(weekStart, 6).toLocaleDateString(
    'es-ES',
    {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    },
  )}`;

  const defaultSessionDate = useMemo(() => {
    const date = new Date();
    date.setSeconds(0, 0);

    const roundedMinutes =
      Math.ceil(date.getMinutes() / 5) * 5;

    date.setMinutes(roundedMinutes);

    if (
      date < weekStart ||
      date >= weekEnd
    ) {
      const firstDay = new Date(weekStart);
      firstDay.setHours(10, 0, 0, 0);

      return formatDateForInput(firstDay);
    }

    return formatDateForInput(date);
  }, [weekStart, weekEnd]);

  return (
    <div className="app-layout">
      <Sidebar syncText="Agenda conectada con procesos clínicos" />

      <main className="dashboard">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">AGENDA</p>
            <h1>Planificación semanal</h1>

            <p className="dashboard-subtitle">
              {weekLabel}
            </p>
          </div>

          <div className="dashboard-actions">
            <button
              type="button"
              className="agenda-navigation-button"
              onClick={() => {
                setSuccessMessage('');
                setWeekStart((currentWeek) =>
                  addDays(currentWeek, -7),
                );
              }}
            >
              ← Semana anterior
            </button>

            <button
              type="button"
              className="agenda-navigation-button"
              onClick={() => {
                setSuccessMessage('');
                setWeekStart(
                  startOfWeek(new Date()),
                );
              }}
            >
              Hoy
            </button>

            <button
              type="button"
              className="agenda-navigation-button"
              onClick={() => {
                setSuccessMessage('');
                setWeekStart((currentWeek) =>
                  addDays(currentWeek, 7),
                );
              }}
            >
              Semana siguiente →
            </button>

            <button
              type="button"
              className="primary-action"
              onClick={() => {
                setError('');
                setSuccessMessage('');
                setNewSessionOpen(true);
              }}
            >
              + Nueva sesión
            </button>
          </div>
        </header>

        {error && (
          <div
            className="dashboard-card agenda-error"
            role="alert"
          >
            {error}
          </div>
        )}

        {successMessage && (
          <div
            className="dashboard-card"
            role="status"
            style={{
              padding: '16px',
              marginBottom: '20px',
              border: '1px solid rgba(0, 120, 90, 0.2)',
              background: 'rgba(0, 120, 90, 0.08)',
              color: '#075c47',
            }}
          >
            {successMessage}
          </div>
        )}

        {newSessionOpen && (
          <section className="dashboard-card agenda-form-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">
                  NUEVA SESIÓN
                </p>

                <h2>Programar una cita</h2>
              </div>

              <button
                type="button"
                className="small-secondary"
                onClick={closeNewSessionForm}
              >
                Cerrar
              </button>
            </div>

            <form
              className="agenda-form"
              onSubmit={createSession}
            >
              <label>
                <span>Paciente</span>

                <select
                  name="patientId"
                  required
                  value={selectedPatientId}
                  onChange={(event) => {
                    setSelectedPatientId(
                      event.target.value,
                    );
                    setError('');
                    setSuccessMessage('');
                  }}
                >
                  <option value="" disabled>
                    Selecciona un paciente
                  </option>

                  {patients.map((patient) => (
                    <option
                      key={patient.id}
                      value={patient.id}
                    >
                      {patient.firstName}{' '}
                      {patient.lastName}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Proceso clínico</span>

                <input
                  type="text"
                  readOnly
                  value={
                    activeProcess?.title ??
                    'Sin proceso clínico activo'
                  }
                />
              </label>

              <label>
                <span>Modalidad</span>

                <input
                  type="text"
                  readOnly
                  value={
                    activeProcess
                      ? MODALITY_LABELS[
                          activeProcess.modality
                        ]
                      : 'No asociada'
                  }
                />
              </label>

              {selectedPatient && !activeProcess && (
                <div
                  className="agenda-form-notes"
                  style={{
                    padding: '12px',
                    borderRadius: '10px',
                    background:
                      'rgba(230, 158, 0, 0.1)',
                    color: '#755100',
                  }}
                >
                  Este paciente no tiene un proceso
                  clínico activo. La cita se intentará
                  guardar sin asociarla a un proceso.
                </div>
              )}

              {activeProcess && (
                <div
                  className="agenda-form-notes"
                  style={{
                    padding: '12px',
                    borderRadius: '10px',
                    background:
                      'rgba(0, 120, 90, 0.08)',
                    color: '#075c47',
                  }}
                >
                  La sesión se asociará a{' '}
                  <strong>
                    {activeProcess.title}
                  </strong>
                  .
                </div>
              )}

              <label>
                <span>Tipo de sesión</span>

                <select
                  name="type"
                  defaultValue="INDIVIDUAL"
                >
                  <option value="INDIVIDUAL">
                    Individual
                  </option>

                  <option value="ASSESSMENT">
                    Evaluación
                  </option>

                  <option value="FOLLOW_UP">
                    Seguimiento
                  </option>

                  <option value="COUPLE">
                    Pareja
                  </option>

                  <option value="FAMILY">
                    Familiar
                  </option>

                  <option value="GROUP">
                    Grupal
                  </option>
                </select>
              </label>

              <label>
                <span>Inicio</span>

                <input
                  name="startsAt"
                  type="datetime-local"
                  required
                  defaultValue={defaultSessionDate}
                />
              </label>

              <label>
                <span>Duración</span>

                <select
                  name="duration"
                  defaultValue="50"
                >
                  <option value="30">
                    30 min
                  </option>

                  <option value="45">
                    45 min
                  </option>

                  <option value="50">
                    50 min
                  </option>

                  <option value="60">
                    60 min
                  </option>

                  <option value="90">
                    90 min
                  </option>
                </select>
              </label>

              <label>
                <span>Ubicación</span>

                <input
                  name="location"
                  type="text"
                  placeholder="Ej. Consulta 2"
                />
              </label>

              <label>
                <span>
                  Enlace de videollamada
                </span>

                <input
                  name="videoCallUrl"
                  type="url"
                  placeholder="https://..."
                />
              </label>

              <label className="agenda-form-notes">
                <span>Notas</span>

                <textarea
                  name="notes"
                  rows={3}
                  placeholder="Información relevante para preparar la sesión..."
                />
              </label>

              <div className="agenda-form-actions">
                <button
                  type="button"
                  className="small-secondary"
                  onClick={closeNewSessionForm}
                >
                  Cancelar
                </button>

                <button
                  type="submit"
                  className="primary-action"
                  disabled={
                    saving ||
                    !selectedPatientId
                  }
                >
                  {saving
                    ? 'Guardando...'
                    : 'Guardar sesión'}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="agenda-week">
          {days.map((day) => {
            const daySessions =
              sessionsForDay(day);

            const isToday = sameDay(
              day,
              new Date(),
            );

            return (
              <article
                key={day.toISOString()}
                className={`agenda-day ${
                  isToday ? 'is-today' : ''
                }`}
              >
                <header className="agenda-day-header">
                  <div>
                    <span>
                      {day.toLocaleDateString(
                        'es-ES',
                        {
                          weekday: 'short',
                        },
                      )}
                    </span>

                    <strong>
                      {day.getDate()}
                    </strong>
                  </div>

                  <small>
                    {daySessions.length}{' '}
                    {daySessions.length === 1
                      ? 'sesión'
                      : 'sesiones'}
                  </small>
                </header>

                <div className="agenda-day-content">
                  {loading ? (
                    <p className="agenda-empty">
                      Cargando...
                    </p>
                  ) : daySessions.length === 0 ? (
                    <p className="agenda-empty">
                      Sin sesiones
                    </p>
                  ) : (
                    daySessions.map((session) => (
                      <div
                        key={session.id}
                        className={`agenda-session agenda-session-${session.status.toLowerCase()}`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            router.push(
                              `/agenda/${session.id}`,
                            )
                          }
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: 0,
                            border: 0,
                            background:
                              'transparent',
                            textAlign: 'left',
                            cursor: 'pointer',
                          }}
                          aria-label={`Abrir sesión de ${getPatientName(
                            session,
                          )}`}
                        >
                          <div className="agenda-session-time">
                            <strong>
                              {formatTime(
                                session.startsAt,
                              )}
                            </strong>

                            <span>
                              {formatDuration(
                                session.startsAt,
                                session.endsAt,
                              )}
                            </span>
                          </div>

                          <div className="agenda-session-patient">
                            <span className="agenda-session-avatar">
                              {getPatientInitials(
                                session,
                              )}
                            </span>

                            <div>
                              <strong>
                                {getPatientName(
                                  session,
                                )}
                              </strong>

                              <small>
                                {
                                  TYPE_LABELS[
                                    session.type
                                  ]
                                }
                                {' · '}
                                {
                                  STATUS_LABELS[
                                    session.status
                                  ]
                                }
                              </small>
                            </div>
                          </div>

                          {session.clinicalProcess && (
                            <p className="agenda-session-notes">
                              Proceso:{' '}
                              <strong>
                                {
                                  session
                                    .clinicalProcess
                                    .title
                                }
                              </strong>
                              {' · '}
                              {
                                MODALITY_LABELS[
                                  session
                                    .clinicalProcess
                                    .modality
                                ]
                              }
                            </p>
                          )}

                          {!session.clinicalProcess && (
                            <p className="agenda-session-notes">
                              Sin proceso clínico
                              asociado
                            </p>
                          )}

                          {session.therapist && (
                            <p className="agenda-session-notes">
                              Terapeuta:{' '}
                              {
                                session.therapist
                                  .firstName
                              }{' '}
                              {
                                session.therapist
                                  .lastName
                              }
                            </p>
                          )}

                          {session.location && (
                            <p className="agenda-session-notes">
                              Ubicación:{' '}
                              {session.location}
                            </p>
                          )}

                          {session.notes && (
                            <p className="agenda-session-notes">
                              {session.notes}
                            </p>
                          )}
                        </button>

                        {session.videoCallUrl && (
                          <p className="agenda-session-notes">
                            <a
                              href={
                                session.videoCallUrl
                              }
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) =>
                                event.stopPropagation()
                              }
                            >
                              Abrir videollamada
                            </a>
                          </p>
                        )}

                        {session.status ===
                          'SCHEDULED' && (
                          <div className="agenda-session-actions">
                            <button
                              type="button"
                              onClick={() =>
                                closeSession(
                                  session.id,
                                  'COMPLETED',
                                )
                              }
                            >
                              Completar
                            </button>

                            <button
                              type="button"
                              onClick={() =>
                                closeSession(
                                  session.id,
                                  'NO_SHOW',
                                )
                              }
                            >
                              No asistió
                            </button>

                            <button
                              type="button"
                              onClick={() =>
                                closeSession(
                                  session.id,
                                  'CANCELLED',
                                )
                              }
                            >
                              Cancelar
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </article>
            );
          })}
        </section>
      </main>
    </div>
  );
}