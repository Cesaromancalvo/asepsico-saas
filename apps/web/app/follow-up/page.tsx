'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';

type Patient = {
  id: string;
  firstName: string;
  lastName: string;
  status: 'ACTIVE' | 'PAUSED' | 'DISCHARGED' | 'ARCHIVED';
  summary: {
    processCount: number;
    sessionCount: number;
    activeProcess?: { id: string; title: string; status: string } | null;
    lastSession?: { startsAt: string; status: string } | null;
    nextSession?: { startsAt: string; status: string } | null;
  };
};

type PatientsResponse = { data: Patient[] };

function formatDate(value?: string | null) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export default function FollowUpPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    api<PatientsResponse>('/patients?status=ACTIVE&pageSize=100')
      .then((response) => setPatients(response.data))
      .catch((err) => setError(err instanceof Error ? err.message : 'No se pudo cargar el seguimiento'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return patients;
    return patients.filter((patient) =>
      `${patient.firstName} ${patient.lastName}`.toLowerCase().includes(text),
    );
  }, [patients, query]);

  const withProcess = patients.filter((patient) => patient.summary.activeProcess).length;
  const withoutNextSession = patients.filter((patient) => !patient.summary.nextSession).length;

  return (
    <div className="app-layout">
      <Sidebar syncText="Seguimiento terapéutico conectado" />
      <main className="patient-record-page">
        <header className="patient-record-header">
          <div>
            <span className="eyebrow">NÚCLEO CLÍNICO</span>
            <h1>Seguimiento terapéutico</h1>
            <p>Accede desde un único lugar al plan, las tareas, las escalas y la evolución de cada paciente.</p>
          </div>
          <Link href="/patients" className="button secondary">Gestionar pacientes</Link>
        </header>

        {error && <div className="agenda-error">{error}</div>}

        <section className="therapy-overview-grid">
          <article><span>Pacientes activos</span><strong>{patients.length}</strong><small>En seguimiento actual</small></article>
          <article><span>Con proceso activo</span><strong>{withProcess}</strong><small>Proceso terapéutico abierto</small></article>
          <article><span>Sin próxima cita</span><strong>{withoutNextSession}</strong><small>Requieren planificación</small></article>
          <article><span>Acceso clínico</span><strong>4</strong><small>Plan, tareas, escalas y sesiones</small></article>
        </section>

        <section className="patient-record-card">
          <div className="task-list-heading">
            <div>
              <h2>Pacientes en seguimiento</h2>
              <p>Selecciona directamente la parte del proceso que quieras revisar.</p>
            </div>
            <input
              aria-label="Buscar paciente"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar paciente…"
              style={{ maxWidth: 280 }}
            />
          </div>

          {loading ? (
            <div className="patient-record-loading">Cargando seguimiento…</div>
          ) : (
            <div className="follow-up-list">
              {filtered.map((patient) => (
                <article key={patient.id} className="follow-up-card">
                  <div className="follow-up-main">
                    <div className="patient-record-avatar">{patient.firstName[0]}{patient.lastName[0]}</div>
                    <div>
                      <h3>{patient.firstName} {patient.lastName}</h3>
                      <p>{patient.summary.activeProcess?.title || 'Sin proceso terapéutico activo'}</p>
                      <small>
                        {patient.summary.sessionCount} sesiones · Próxima: {formatDate(patient.summary.nextSession?.startsAt)}
                      </small>
                    </div>
                  </div>
                  <div className="follow-up-actions">
                    <Link href={`/patients/${patient.id}/plan`} className="button">Plan y evolución</Link>
                    <Link href={`/patients/${patient.id}/tasks`} className="button secondary">Tareas</Link>
                    <Link href={`/patients/${patient.id}/assessments`} className="button secondary">Escalas</Link>
                    <Link href={`/agenda?patientId=${patient.id}`} className="button secondary">Sesiones</Link>
                    <Link href={`/patients/${patient.id}`} className="button secondary">Ficha</Link>
                  </div>
                </article>
              ))}
              {!filtered.length && (
                <div className="therapy-empty">
                  <strong>No hay pacientes para mostrar</strong>
                  <p>Crea un paciente o cambia la búsqueda para comenzar el seguimiento.</p>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
