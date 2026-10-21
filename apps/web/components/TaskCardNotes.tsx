'use client';

import type { TaskStatus } from './TaskActions';

type NotesTask = { id: string; status: TaskStatus; reviewComment?: string | null; clinicianNotes?: string | null };

/**
 * Campos de texto de la tarjeta de tarea del profesional:
 *  - "Devolución profesional" (lectura) cuando ya no está entregada, solo con `reviewComment`;
 *  - "Devolución para el paciente" (editable) mientras está entregada;
 *  - "Nota clínica privada", siempre en su propio campo, nunca dentro del bloque de devolución.
 * Las `key` incluyen el valor del servidor: si un guardado falla y la lista vuelve al estado real,
 * el campo se vuelve a montar con ese valor y no se queda mostrando un texto no guardado.
 * Solo se monta con TREATING (ClinicalSubpageGate): con acceso excepcional no hay nota ni PATCH.
 */
export default function TaskCardNotes({ task, onSaveNote }: { task: NotesTask; onSaveNote: (value: string) => void }) {
  const note = task.clinicianNotes ?? '';
  const review = task.reviewComment ?? '';
  return (
    <>
      {review && task.status !== 'SUBMITTED' && (
        <div className="patient-record-card task-review-readonly"><strong>Devolución profesional</strong><p>{review}</p></div>
      )}
      <div className="task-notes-grid">
        {task.status === 'SUBMITTED' && (
          <label className="task-review-field">
            <span>Devolución para el paciente</span>
            <textarea key={`review-${task.id}:${review}`} id={`review-${task.id}`} defaultValue={review} placeholder="Feedback breve, claro y no punitivo…" />
          </label>
        )}
        <label className="task-private-note">
          <span>Nota clínica privada</span>
          <textarea
            key={`note-${task.id}:${note}`}
            defaultValue={note}
            placeholder="Solo para ti; el paciente no la ve."
            onBlur={(e) => { if (e.target.value !== note) onSaveNote(e.target.value); }}
          />
        </label>
      </div>
    </>
  );
}
