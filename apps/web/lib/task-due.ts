/*
 * Tareas vencidas (solo en la parte del profesional). En el portal del paciente NO se usa: allí la
 * fecha es orientativa y no queremos meter presión.
 *
 * Una tarea está vencida si sigue en manos del paciente (asignada, en curso o con cambios
 * solicitados) y su fecha límite es de un día ANTERIOR a hoy. El mismo día de la fecha aún no lo está.
 * Se compara por día natural en la hora del navegador, igual que se pinta la fecha.
 */

/** Estados en los que la tarea espera al paciente. Entregada, completada, borrador o cancelada, no. */
export const OPEN_TASK_STATUSES: readonly string[] = ['PENDING', 'IN_PROGRESS', 'CHANGES_REQUESTED'];

export const OVERDUE_LABEL = 'Vencida';

const pad = (value: number) => String(value).padStart(2, '0');
const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function isTaskOverdue(task: { status: string; dueDate?: string | null }, now: Date = new Date()): boolean {
  if (!task.dueDate || !OPEN_TASK_STATUSES.includes(task.status)) return false;
  const due = new Date(task.dueDate);
  if (Number.isNaN(due.getTime())) return false;
  return dayKey(due) < dayKey(now);
}
