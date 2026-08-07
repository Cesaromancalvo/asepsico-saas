'use client';

import {
  FormEvent,
  useEffect,
  useState,
} from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import Sidebar from '@/components/Sidebar';

type PatientStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'DISCHARGED'
  | 'ARCHIVED';

type ProcessStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'DISCHARGED'
  | 'CLOSED';

type Therapist = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
};

type ClinicalProcess = {
  id: string;
  title: string;
  status: ProcessStatus;
  modality?: string;
  frequency?: string;
  startedAt?: string;
  therapist?: Therapist | null;
};

type SessionSummary = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  type?: string;
};

type PatientSummary = {
  processCount: number;
  sessionCount: number;
  activeProcess: ClinicalProcess | null;
  lastSession: SessionSummary | null;
  nextSession: SessionSummary | null;
  therapist: Therapist | null;
};

type Patient = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  consultationReason?: string;
  status: PatientStatus;
  summary: PatientSummary;
};

type PatientsPageResponse = {
  data: Patient[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

const TABS: {
  label: string;
  value: PatientStatus;
}[] = [
  {
    label: 'Activos',
    value: 'ACTIVE',
  },
  {
    label: 'Pausados',
    value: 'PAUSED',
  },
  {
    label: 'De alta',
    value: 'DISCHARGED',
  },
  {
    label: 'Archivados',
    value: 'ARCHIVED',
  },
];

const STATUS_LABEL: Record<
  PatientStatus,
  string
> = {
  ACTIVE: 'Activo',
  PAUSED: 'Pausado',
  DISCHARGED: 'De alta',
  ARCHIVED: 'Archivado',
};

function formatDate(
  value?: string | null,
  includeTime = false,
) {
  if (!value) {
    return 'Sin registrar';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Fecha no disponible';
  }

  return date.toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(includeTime
      ? {
          hour: '2-digit',
          minute: '2-digit',
        }
      : {}),
  });
}

function therapistName(
  therapist?: Therapist | null,
) {
  if (!therapist) {
    return 'Sin terapeuta asignado';
  }

  return `${therapist.firstName} ${therapist.lastName}`;
}

export default function PatientsPage() {
  const [page, setPage] =
    useState<PatientsPageResponse>({
      data: [],
      meta: {
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 1,
      },
    });

  const [status, setStatus] =
    useState<PatientStatus>('ACTIVE');

  const [selectedPatientId, setSelectedPatientId] =
    useState<string | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] = useState('');

  const selectedPatient =
    page.data.find(
      (patient) =>
        patient.id === selectedPatientId,
    ) ?? null;

  async function load(
    targetStatus = status,
  ) {
    try {
      setLoading(true);
      setError('');

      const response =
        await api<PatientsPageResponse>(
          `/patients?status=${targetStatus}&pageSize=50`,
        );

      setPage(response);

      setSelectedPatientId(
        (currentId) => {
          const stillExists =
            response.data.some(
              (patient) =>
                patient.id === currentId,
            );

          if (stillExists) {
            return currentId;
          }

          return response.data[0]?.id ?? null;
        },
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudieron cargar los pacientes',
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(status);
  }, [status]);

  async function createPatient(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);

    try {
      setError('');

      await api('/patients', {
        method: 'POST',
        body: JSON.stringify({
          firstName:
            formData.get('firstName'),
          lastName:
            formData.get('lastName'),
          email:
            formData.get('email') ||
            undefined,
          phone:
            formData.get('phone') ||
            undefined,
          consultationReason:
            formData.get(
              'consultationReason',
            ) || undefined,
        }),
      });

      form.reset();

      if (status !== 'ACTIVE') {
        setStatus('ACTIVE');
      } else {
        await load('ACTIVE');
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudo crear el paciente',
      );
    }
  }

  async function createProcess(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (!selectedPatient) {
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData(form);

    try {
      setError('');

      await api('/clinical-processes', {
        method: 'POST',
        body: JSON.stringify({
          patientId: selectedPatient.id,
          title:
            formData.get('title') ||
            'Proceso de intervención',
          consultationReason:
            formData.get(
              'consultationReason',
            ) ||
            selectedPatient.consultationReason ||
            undefined,
          goals:
            formData.get('goals') ||
            undefined,
          modality:
            formData.get('modality') ||
            'IN_PERSON',
          frequency:
            formData.get('frequency') ||
            undefined,
        }),
      });

      form.reset();
      await load();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudo crear el proceso',
      );
    }
  }

  async function changeStatus(
    id: string,
    next:
      | 'ACTIVE'
      | 'PAUSED'
      | 'DISCHARGED',
  ) {
    try {
      setError('');

      await api(
        `/patients/${id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: next,
          }),
        },
      );

      await load();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudo cambiar el estado',
      );
    }
  }

  // Transiciones válidas, en espejo de ALLOWED_TRANSITIONS en clinical-processes.service.ts.
  // CLOSED es terminal: no se ofrece ningún botón para salir de ahí.
  const PROCESS_TRANSITIONS: Record<ProcessStatus, { label: string; to: ProcessStatus }[]> = {
    ACTIVE: [
      { label: 'Pausar', to: 'PAUSED' },
      { label: 'Dar de alta', to: 'DISCHARGED' },
      { label: 'Cerrar proceso', to: 'CLOSED' },
    ],
    PAUSED: [
      { label: 'Reactivar', to: 'ACTIVE' },
      { label: 'Dar de alta', to: 'DISCHARGED' },
      { label: 'Cerrar proceso', to: 'CLOSED' },
    ],
    DISCHARGED: [{ label: 'Reabrir proceso', to: 'ACTIVE' }],
    CLOSED: [],
  };

  async function changeProcessStatus(processId: string, next: ProcessStatus) {
    try {
      setError('');
      await api(`/clinical-processes/${processId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cambiar el estado del proceso');
    }
  }

  async function archive(id: string) {
    try {
      setError('');

      await api(`/patients/${id}`, {
        method: 'DELETE',
      });

      await load();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudo archivar',
      );
    }
  }

  async function restore(id: string) {
    try {
      setError('');

      await api(
        `/patients/${id}/restore`,
        {
          method: 'POST',
        },
      );

      await load();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudo restaurar',
      );
    }
  }

  return (
    <div className="app-layout">
      <Sidebar syncText="Pacientes y procesos clínicos" />
      <main className="patient-record-page">
        <header className="patient-record-header">
          <div><span className="eyebrow">PACIENTES</span><h1>Pacientes y procesos</h1><p>Selecciona un paciente, abre su ficha o gestiona su proceso terapéutico sin salir de la navegación principal.</p></div>
          <Link href="/follow-up" className="button">Ir a seguimiento</Link>
        </header>

      {error && (
        <p className="error">{error}</p>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'minmax(0, 1.7fr) minmax(320px, 1fr)',
          gap: 20,
          alignItems: 'start',
        }}
      >
        <section className="card">
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginBottom: 18,
              flexWrap: 'wrap',
            }}
          >
            {TABS.map((tab) => (
              <button
                key={tab.value}
                className={
                  status === tab.value
                    ? 'button'
                    : 'button secondary'
                }
                onClick={() =>
                  setStatus(tab.value)
                }
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent:
                'space-between',
              alignItems: 'center',
              marginBottom: 16,
              gap: 12,
            }}
          >
            <div>
              <h2
                style={{
                  marginBottom: 4,
                }}
              >
                Pacientes
              </h2>

              <div className="muted">
                {page.meta.total}{' '}
                {page.meta.total === 1
                  ? 'persona'
                  : 'personas'}
              </div>
            </div>
          </div>

          {loading ? (
            <p className="muted">
              Cargando pacientes…
            </p>
          ) : (
            <div className="stack">
              {page.data.map((patient) => {
                const isSelected =
                  patient.id ===
                  selectedPatientId;

                return (
                  <article
                    className="patient"
                    key={patient.id}
                    onClick={() =>
                      setSelectedPatientId(
                        patient.id,
                      )
                    }
                    style={{
                      cursor: 'pointer',
                      border: isSelected
                        ? '2px solid currentColor'
                        : undefined,
                      display: 'block',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent:
                          'space-between',
                        gap: 16,
                        alignItems:
                          'flex-start',
                      }}
                    >
                      <div>
                        <strong>
                          {patient.firstName}{' '}
                          {patient.lastName}
                        </strong>

                        <div
                          className="muted"
                          style={{
                            marginTop: 4,
                          }}
                        >
                          {patient
                            .consultationReason ||
                            patient.email ||
                            'Sin información adicional'}
                        </div>
                      </div>

                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                        }}
                      >
                        {
                          STATUS_LABEL[
                            patient.status
                          ]
                        }
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns:
                          'repeat(4, minmax(0, 1fr))',
                        gap: 10,
                        marginTop: 16,
                      }}
                    >
                      <div>
                        <div className="muted">
                          Procesos
                        </div>
                        <strong>
                          {
                            patient.summary
                              .processCount
                          }
                        </strong>
                      </div>

                      <div>
                        <div className="muted">
                          Sesiones
                        </div>
                        <strong>
                          {
                            patient.summary
                              .sessionCount
                          }
                        </strong>
                      </div>

                      <div>
                        <div className="muted">
                          Última sesión
                        </div>
                        <strong
                          style={{
                            fontSize: 13,
                          }}
                        >
                          {formatDate(
                            patient.summary
                              .lastSession
                              ?.startsAt,
                          )}
                        </strong>
                      </div>

                      <div>
                        <div className="muted">
                          Próxima sesión
                        </div>
                        <strong
                          style={{
                            fontSize: 13,
                          }}
                        >
                          {formatDate(
                            patient.summary
                              .nextSession
                              ?.startsAt,
                            true,
                          )}
                        </strong>
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent:
                          'space-between',
                        alignItems: 'center',
                        gap: 12,
                        marginTop: 16,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div className="muted">
                        {patient.summary
                          .activeProcess
                          ? `Proceso activo: ${patient.summary.activeProcess.title}`
                          : 'Sin proceso activo'}
                        {' · '}
                        {therapistName(
                          patient.summary
                            .therapist,
                        )}
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          gap: 6,
                          flexWrap: 'wrap',
                        }}
                        onClick={(event) =>
                          event.stopPropagation()
                        }
                      >
                        <Link href={`/patients/${patient.id}`} className="button">Abrir ficha</Link>

                        {patient.status ===
                          'ACTIVE' && (
                          <>
                            <button
                              className="button secondary"
                              onClick={() =>
                                changeStatus(
                                  patient.id,
                                  'PAUSED',
                                )
                              }
                            >
                              Pausar
                            </button>

                            <button
                              className="button secondary"
                              onClick={() =>
                                changeStatus(
                                  patient.id,
                                  'DISCHARGED',
                                )
                              }
                            >
                              Dar de alta
                            </button>
                          </>
                        )}

                        {patient.status ===
                          'PAUSED' && (
                          <>
                            <button
                              className="button secondary"
                              onClick={() =>
                                changeStatus(
                                  patient.id,
                                  'ACTIVE',
                                )
                              }
                            >
                              Reactivar
                            </button>

                            <button
                              className="button secondary"
                              onClick={() =>
                                changeStatus(
                                  patient.id,
                                  'DISCHARGED',
                                )
                              }
                            >
                              Dar de alta
                            </button>
                          </>
                        )}

                        {patient.status ===
                          'DISCHARGED' && (
                          <button
                            className="button secondary"
                            onClick={() =>
                              changeStatus(
                                patient.id,
                                'ACTIVE',
                              )
                            }
                          >
                            Reabrir
                          </button>
                        )}

                        {patient.status !==
                          'ARCHIVED' && (
                          <button
                            className="button secondary"
                            onClick={() =>
                              archive(
                                patient.id,
                              )
                            }
                          >
                            Archivar
                          </button>
                        )}

                        {patient.status ===
                          'ARCHIVED' && (
                          <button
                            className="button secondary"
                            onClick={() =>
                              restore(
                                patient.id,
                              )
                            }
                          >
                            Restaurar
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}

              {page.data.length === 0 && (
                <p className="muted">
                  No hay pacientes en esta
                  vista.
                </p>
              )}
            </div>
          )}
        </section>

        <aside
          style={{
            display: 'grid',
            gap: 20,
          }}
        >
          {selectedPatient ? (
            <section className="card">
              <div className="muted">
                Expediente seleccionado
              </div>

              <h2
                style={{
                  marginTop: 6,
                  marginBottom: 4,
                }}
              >
                {selectedPatient.firstName}{' '}
                {selectedPatient.lastName}
              </h2>

              <p className="muted">
                {selectedPatient
                  .consultationReason ||
                  'Sin motivo de consulta registrado'}
              </p>

              <div
                style={{
                  display: 'grid',
                  gap: 12,
                  marginTop: 20,
                }}
              >
                <div>
                  <div className="muted">
                    Proceso activo
                  </div>

                  <strong>
                    {selectedPatient.summary
                      .activeProcess
                      ?.title ||
                      'Sin proceso activo'}
                  </strong>

                  {selectedPatient.summary.activeProcess && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      {PROCESS_TRANSITIONS[selectedPatient.summary.activeProcess.status].map((t) => (
                        <button
                          key={t.to}
                          type="button"
                          className="button secondary"
                          onClick={() => changeProcessStatus(selectedPatient.summary.activeProcess!.id, t.to)}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="muted">
                    Terapeuta responsable
                  </div>

                  <strong>
                    {therapistName(
                      selectedPatient.summary
                        .therapist,
                    )}
                  </strong>
                </div>

                <div>
                  <div className="muted">
                    Frecuencia
                  </div>

                  <strong>
                    {selectedPatient.summary
                      .activeProcess
                      ?.frequency ||
                      'No indicada'}
                  </strong>
                </div>

                <div>
                  <div className="muted">
                    Próxima sesión
                  </div>

                  <strong>
                    {formatDate(
                      selectedPatient.summary
                        .nextSession
                        ?.startsAt,
                      true,
                    )}
                  </strong>
                </div>
              </div>

              {(!selectedPatient.summary
                .activeProcess ||
                selectedPatient.summary
                  .activeProcess.status ===
                  'CLOSED') &&
                selectedPatient.status !==
                  'ARCHIVED' && (
                  <form
                    onSubmit={createProcess}
                    style={{
                      marginTop: 24,
                    }}
                  >
                    <h3>
                      Abrir proceso clínico
                    </h3>

                    <label className="field">
                      Nombre del proceso
                      <input
                        name="title"
                        required
                        defaultValue="Proceso de intervención individual"
                      />
                    </label>

                    <label className="field">
                      Motivo de consulta
                      <input
                        name="consultationReason"
                        defaultValue={
                          selectedPatient.consultationReason ??
                          ''
                        }
                      />
                    </label>

                    <label className="field">
                      Objetivos iniciales
                      <textarea
                        name="goals"
                        rows={3}
                      />
                    </label>

                    <label className="field">
                      Modalidad
                      <select
                        name="modality"
                        defaultValue="IN_PERSON"
                      >
                        <option value="IN_PERSON">
                          Presencial
                        </option>
                        <option value="ONLINE">
                          Online
                        </option>
                        <option value="HYBRID">
                          Híbrida
                        </option>
                      </select>
                    </label>

                    <label className="field">
                      Frecuencia
                      <input
                        name="frequency"
                        placeholder="Ej. Semanal"
                      />
                    </label>

                    <button className="button">
                      Crear proceso
                    </button>
                  </form>
                )}
            </section>
          ) : (
            <section className="card">
              <h2>
                Expediente clínico
              </h2>

              <p className="muted">
                Selecciona un paciente para
                consultar su proceso.
              </p>
            </section>
          )}

          <section className="card">
            <h2>Nueva persona</h2>

            <form
              onSubmit={createPatient}
            >
              <label className="field">
                Nombre
                <input
                  name="firstName"
                  required
                  minLength={2}
                />
              </label>

              <label className="field">
                Apellidos
                <input
                  name="lastName"
                  required
                  minLength={2}
                />
              </label>

              <label className="field">
                Correo
                <input
                  name="email"
                  type="email"
                />
              </label>

              <label className="field">
                Teléfono
                <input name="phone" />
              </label>

              <label className="field">
                Motivo de consulta
                <input name="consultationReason" />
              </label>

              <button className="button">
                Crear paciente
              </button>
            </form>
          </section>
        </aside>
      </div>
      </main>
    </div>
  );
}