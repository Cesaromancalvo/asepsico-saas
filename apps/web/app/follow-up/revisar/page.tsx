'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { EmptyState } from '@/components/Icon';
import { api } from '@/lib/api';
import { useViewer } from '@/lib/clinical';
import { patientTasksToReviewHref, taskReviewPatientId } from '@/lib/routes';

type AttentionItem = { id: string; type: string; title: string; subtitle: string; href: string };
type DashboardAttention = { attention: AttentionItem[] };

/** GET /dashboard devuelve como mucho 5 entregas (las que más tiempo llevan esperando). */
const DASHBOARD_REVIEW_LIMIT = 5;

/**
 * «Tareas por revisar»: tareas que los pacientes han entregado y esperan la revisión del
 * profesional. Destino de la tarjeta de Mi jornada cuando hay entregas de varios pacientes.
 *
 * Datos: los mismos avisos TASK_REVIEW de GET /dashboard (la API solo los da de pacientes que el
 * profesional trata, con título de la tarea y nombre del paciente; nunca respuestas ni notas).
 * Cada fila lleva a las tareas del paciente con el filtro «Por revisar».
 */
export default function TasksToReviewPage() {
  const viewer = useViewer();
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    try {
      setLoading(true);
      setError('');
      const data = await api<DashboardAttention>('/dashboard');
      setItems(data.attention.filter((item) => item.type === 'TASK_REVIEW' && taskReviewPatientId(item.href)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las tareas por revisar.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (viewer?.isClinician) void load();
    else if (viewer) setLoading(false);
  }, [viewer]);

  return (
    <div className="app-layout">
      <Sidebar syncText="Trabajo entre sesiones" />
      <main className="patient-record-page">
        <header className="patient-record-header">
          <div>
            <Link href="/" className="patient-record-back">← Volver a Mi jornada</Link>
            <span className="eyebrow">TAREAS ENTREGADAS</span>
            <h1>Tareas por revisar</h1>
            <p>Lo que tus pacientes han entregado y espera tu revisión.</p>
          </div>
        </header>

        {viewer && !viewer.isClinician ? (
          <div className="e1-notice info" role="note">
            <div><strong>Solo para profesionales</strong><p>Las tareas las revisa el profesional que atiende a cada paciente.</p></div>
          </div>
        ) : (
          <section className="patient-record-card">
            {loading ? (
              <div className="patient-record-loading" role="status">Cargando tareas por revisar…</div>
            ) : error ? (
              <>
                <div className="agenda-error" role="alert">{error}</div>
                <button type="button" className="button secondary" onClick={() => void load()}>Reintentar</button>
              </>
            ) : items.length === 0 ? (
              <EmptyState icon="checkCircle" title="Todo revisado">No hay tareas entregadas pendientes de revisar.</EmptyState>
            ) : (
              <>
              {items.length >= DASHBOARD_REVIEW_LIMIT && (
                <p className="reschedule-hint review-limit-note" role="note">
                  Mostrando las {DASHBOARD_REVIEW_LIMIT} entregas que llevan más tiempo esperando. Puede haber más: las verás en las tareas de cada paciente.
                </p>
              )}
              <ul className="task-list review-task-list">
                {items.map((item) => (
                  <li key={item.id}>
                    <Link href={patientTasksToReviewHref(taskReviewPatientId(item.href))} className="task-row">
                      <span><strong>{item.title}</strong><small>{item.subtitle}</small></span>
                      <span className="text-link">Revisar</span>
                    </Link>
                  </li>
                ))}
              </ul>
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
