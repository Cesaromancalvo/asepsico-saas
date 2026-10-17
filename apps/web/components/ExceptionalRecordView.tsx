'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ClinicalProcessRow, processLabel, therapistName } from '@/lib/clinical';
import { exceptionalAllowsExport } from '@/lib/exceptional-access';

export type ReadOnlyHistory = Record<string, string | null | undefined>;
type Goal = { id: string; title: string; status: string; targetDate?: string | null };
type Task = { id: string; title: string; status: string; dueDate?: string | null };
type Assessment = { id: string; scaleName: string; totalScore: number; severity: string; administeredAt: string };
type DocumentItem = { id: string; title: string; type: string; createdAt: string };
type TimelineEvent = { id: string; type: string; date: string; title: string };

type Props = {
  patientId: string;
  reasonCode: string;
  history: ReadOnlyHistory;
  goals: Goal[];
  tasks: Task[];
  assessments: Assessment[];
  documents: DocumentItem[];
  timeline: TimelineEvent[];
  processes: ClinicalProcessRow[];
};

/** Campos de la historia clínica en el orden de la ficha. */
const HISTORY_FIELDS: Array<[string, string]> = [
  ['reasonForConsultation', 'Motivo de consulta'],
  ['currentProblem', 'Problema actual y evolución'],
  ['primaryDiagnosis', 'Diagnóstico o hipótesis clínica'],
  ['personalHistory', 'Antecedentes personales'],
  ['familyHistory', 'Antecedentes familiares'],
  ['medicalHistory', 'Antecedentes médicos'],
  ['currentMedication', 'Medicación actual'],
  ['riskFactors', 'Factores de riesgo'],
  ['protectiveFactors', 'Factores protectores'],
  ['clinicalObservations', 'Observaciones clínicas'],
];

const GOAL_STATUS: Record<string, string> = { ACTIVE: 'Activo', ACHIEVED: 'Conseguido', PAUSED: 'En pausa', CANCELLED: 'Cancelado' };
const TASK_STATUS: Record<string, string> = { DRAFT: 'Borrador', PENDING: 'Pendiente', IN_PROGRESS: 'En curso', SUBMITTED: 'Entregada', CHANGES_REQUESTED: 'Con cambios pedidos', COMPLETED: 'Completada', CANCELLED: 'Cancelada' };
const EVENT_LABEL: Record<string, string> = { SESSION: 'Sesión', GOAL: 'Objetivo', TASK: 'Tarea', ASSESSMENT: 'Escala', DOCUMENT: 'Documento', HISTORY: 'Historia', PROCESS: 'Proceso', CONSENT: 'Consentimiento', REPORT: 'Informe', RESOURCE: 'Recurso', PATIENT_CREATED: 'Alta' };

function formatDate(value?: string | null) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Historia en solo lectura durante un acceso excepcional (§3.4). Sin formularios ni botones de
 * escritura; las notas internas de los profesionales no llegan de la API y aquí tampoco se
 * pintan (ni las de las tareas ni las de las escalas). La exportación completa solo aparece con
 * los tres motivos que la permiten.
 */
export default function ExceptionalRecordView({ patientId, reasonCode, history, goals, tasks, assessments, documents, timeline, processes }: Props) {
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');
  const filled = HISTORY_FIELDS.filter(([key]) => (history[key] ?? '').toString().trim());

  async function exportRecord() {
    // Mismo paso que en Datos y piloto: la exportación pide confirmar la contraseña (POST con CSRF).
    const password = window.prompt('Confirma tu contraseña para exportar la historia (sin notas internas)');
    if (!password) return;
    setExportBusy(true); setExportError('');
    try {
      const data = await api(`/exports/patients/${patientId}`, { method: 'POST', body: JSON.stringify({ password }) });
      downloadJson(`asepsico-paciente-${patientId}.json`, data);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'No se pudo exportar la historia');
    } finally { setExportBusy(false); }
  }

  return (
    <div className="xa-record">
      <section className="patient-record-card" aria-labelledby="xa-record-history">
        <div className="patient-unified-card-heading"><div><span>Solo lectura</span><h2 id="xa-record-history">Historia clínica</h2></div></div>
        {filled.length ? (
          <dl className="xa-readonly-list">
            {filled.map(([key, label]) => <div key={key}><dt>{label}</dt><dd className="e1-readonly-text">{history[key]}</dd></div>)}
          </dl>
        ) : <p className="xa-empty">La historia clínica de este paciente está vacía.</p>}
      </section>

      <section className="patient-record-card" aria-labelledby="xa-record-processes">
        <div className="patient-unified-card-heading"><div><span>Procesos</span><h2 id="xa-record-processes">Procesos clínicos</h2></div></div>
        {processes.length ? (
          <ul className="e1-list">
            {processes.map((process) => (
              <li key={process.id} className="e1-row">
                <div><strong>{processLabel({ status: process.status, modality: process.modality })}</strong><small>{therapistName(process.therapist)} · desde {formatDate(process.startedAt)}</small></div>
                <div><span className="e1-badge readonly">Solo lectura</span></div>
                <div><Link href={`/patients/${patientId}/processes/${process.id}`} className="button secondary" aria-label={`Abrir el proceso de ${therapistName(process.therapist)}`}>Abrir</Link></div>
              </li>
            ))}
          </ul>
        ) : <p className="xa-empty">Este paciente no tiene procesos.</p>}
      </section>

      <div className="xa-record-grid">
        <section className="patient-record-card" aria-labelledby="xa-record-goals">
          <h2 id="xa-record-goals" className="xa-h">Objetivos</h2>
          {goals.length ? <ul className="xa-plain-list">{goals.map((goal) => <li key={goal.id}><strong>{goal.title}</strong><small>{GOAL_STATUS[goal.status] ?? goal.status}{goal.targetDate ? ` · objetivo ${formatDate(goal.targetDate)}` : ''}</small></li>)}</ul> : <p className="xa-empty">Sin objetivos.</p>}
        </section>
        <section className="patient-record-card" aria-labelledby="xa-record-tasks">
          <h2 id="xa-record-tasks" className="xa-h">Tareas</h2>
          {tasks.length ? <ul className="xa-plain-list">{tasks.map((task) => <li key={task.id}><strong>{task.title}</strong><small>{TASK_STATUS[task.status] ?? task.status}{task.dueDate ? ` · vence ${formatDate(task.dueDate)}` : ''}</small></li>)}</ul> : <p className="xa-empty">Sin tareas.</p>}
        </section>
        <section className="patient-record-card" aria-labelledby="xa-record-scales">
          <h2 id="xa-record-scales" className="xa-h">Escalas</h2>
          {assessments.length ? <ul className="xa-plain-list">{assessments.map((item) => <li key={item.id}><strong>{item.scaleName} · {item.totalScore}</strong><small>{item.severity} · {formatDate(item.administeredAt)}</small></li>)}</ul> : <p className="xa-empty">Sin escalas.</p>}
        </section>
        <section className="patient-record-card" aria-labelledby="xa-record-docs">
          <h2 id="xa-record-docs" className="xa-h">Documentos e informes</h2>
          {documents.length ? <ul className="xa-plain-list">{documents.map((doc) => <li key={doc.id}><strong>{doc.title}</strong><small>{formatDate(doc.createdAt)}</small></li>)}</ul> : <p className="xa-empty">Sin documentos.</p>}
        </section>
      </div>

      <section className="patient-record-card" aria-labelledby="xa-record-timeline">
        <h2 id="xa-record-timeline" className="xa-h">Actividad</h2>
        {timeline.length ? <ul className="xa-plain-list">{timeline.slice(0, 20).map((item) => <li key={item.id}><strong>{EVENT_LABEL[item.type] ?? 'Evento'}: {item.title}</strong><small>{formatDate(item.date)}</small></li>)}</ul> : <p className="xa-empty">Sin actividad registrada.</p>}
      </section>

      {exceptionalAllowsExport(reasonCode) && (
        <section className="patient-record-card" aria-labelledby="xa-record-export">
          <h2 id="xa-record-export" className="xa-h">Exportar la historia</h2>
          <p className="muted">El motivo de este acceso permite exportar la historia completa. No incluye las notas internas de los profesionales y queda registrado. Protege el archivo fuera de AsePsico.</p>
          <button type="button" className="button secondary" disabled={exportBusy} onClick={exportRecord}>{exportBusy ? 'Preparando…' : 'Exportar historia (sin notas internas)'}</button>
          {exportError && <p className="agenda-error" role="alert">{exportError}</p>}
        </section>
      )}
    </div>
  );
}
