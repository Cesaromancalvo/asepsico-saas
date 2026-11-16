import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTaskOverdue, OPEN_TASK_STATUSES, OVERDUE_LABEL } from '../lib/task-due';

/* Tareas vencidas (recorrido de demo 14/11, punto 7). Datos ficticios. */

// 1 de noviembre de 2026 a media mañana (hora local del navegador de los tests).
const NOW = new Date(2026, 10, 1, 10, 30);
// La web guarda la fecha del <input type="date"> como medianoche UTC.
const OCT_31 = '2026-10-31T00:00:00.000Z';
const NOV_1 = new Date(2026, 10, 1, 0, 0).toISOString();
const NOV_2 = '2026-11-02T00:00:00.000Z';

describe('isTaskOverdue', () => {
  it('pendiente con fecha de ayer → vencida', () => {
    expect(isTaskOverdue({ status: 'PENDING', dueDate: OCT_31 }, NOW)).toBe(true);
  });

  it('el mismo día de la fecha todavía no está vencida; mañana tampoco', () => {
    expect(isTaskOverdue({ status: 'PENDING', dueDate: NOV_1 }, NOW)).toBe(false);
    expect(isTaskOverdue({ status: 'PENDING', dueDate: NOV_2 }, NOW)).toBe(false);
  });

  it('solo mientras espera al paciente (asignada, en curso, cambios solicitados)', () => {
    expect([...OPEN_TASK_STATUSES]).toEqual(['PENDING', 'IN_PROGRESS', 'CHANGES_REQUESTED']);
    for (const status of OPEN_TASK_STATUSES) expect(isTaskOverdue({ status, dueDate: OCT_31 }, NOW)).toBe(true);
    for (const status of ['DRAFT', 'SUBMITTED', 'COMPLETED', 'CANCELLED']) expect(isTaskOverdue({ status, dueDate: OCT_31 }, NOW)).toBe(false);
  });

  it('sin fecha o con fecha inválida, nunca', () => {
    expect(isTaskOverdue({ status: 'PENDING', dueDate: null }, NOW)).toBe(false);
    expect(isTaskOverdue({ status: 'PENDING' }, NOW)).toBe(false);
    expect(isTaskOverdue({ status: 'PENDING', dueDate: 'mañana' }, NOW)).toBe(false);
  });

  it('la etiqueta es «Vencida»', () => {
    expect(OVERDUE_LABEL).toBe('Vencida');
  });
});

describe('dónde aparece', () => {
  const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

  it.each(['app/patients/view/page.tsx', 'app/patients/view/tasks/page.tsx', 'components/ExceptionalRecordView.tsx'])('%s marca las vencidas', (path) => {
    const code = source(path);
    expect(code).toContain('isTaskOverdue(');
    expect(code).toContain('OVERDUE_LABEL');
  });

  it('el portal del paciente NO marca vencidas (la fecha es orientativa, sin presión)', () => {
    const portal = source('app/portal/page.tsx');
    expect(portal).not.toContain('task-due');
    expect(portal).not.toMatch(/[Vv]encid/);
    expect(portal).toContain('Una fecha es orientativa, no una penalización.');
  });
});
