import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskActions, { TaskStatus } from '../components/TaskActions';

const noop = () => undefined;
const render = (status: TaskStatus, busy = false) => renderToStaticMarkup(
  <TaskActions task={{ status }} busy={busy} onAssign={noop} onRemoveDraft={noop} onComplete={noop} onRequestChanges={noop} onReopen={noop} onCancel={noop} />,
);
const primary = (html: string) => html.match(/class="button task-action-primary"[^>]*>([^<]*)</)?.[1] ?? null;
const secondary = (html: string) => [...html.matchAll(/class="task-action-secondary[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);

describe('TaskActions (tarjeta de tarea del profesional)', () => {
  it('borrador: "Asignar" como acción principal y "Eliminar borrador" como secundaria', () => {
    const html = render('DRAFT');
    expect(primary(html)).toBe('Asignar');
    expect(secondary(html)).toEqual(['Eliminar borrador']);
  });

  it('entregada: "Completar tras revisión" principal; "Solicitar cambios" y "Cancelar tarea" secundarias', () => {
    const html = render('SUBMITTED');
    expect(primary(html)).toBe('Completar tras revisión');
    expect(secondary(html)).toEqual(['Solicitar cambios', 'Cancelar tarea']);
  });

  it.each<TaskStatus>(['PENDING', 'IN_PROGRESS', 'CHANGES_REQUESTED'])('%s: sin acción principal, solo "Cancelar tarea"', (status) => {
    const html = render(status);
    expect(primary(html)).toBeNull();
    expect(secondary(html)).toEqual(['Cancelar tarea']);
  });

  it('completada: solo "Reabrir"; cancelada: sin acciones', () => {
    expect(secondary(render('COMPLETED'))).toEqual(['Reabrir']);
    expect(render('CANCELLED')).toBe('');
  });

  it('mientras guarda deshabilita todos los botones y la principal dice "Guardando…"', () => {
    const html = render('SUBMITTED', true);
    expect(primary(html)).toBe('Guardando…');
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it('todos los botones son type="button" (no envían formularios)', () => {
    const html = render('SUBMITTED');
    expect(html.match(/<button type="button"/g)).toHaveLength(3);
  });
});
