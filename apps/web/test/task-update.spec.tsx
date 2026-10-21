import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskCardNotes from '../components/TaskCardNotes';
import { applyOptimistic, REFRESH_FAILED_AFTER_SAVE, settleTaskUpdate } from '../lib/task-update';

type T = { id: string; status: string; reviewComment?: string | null; clinicianNotes?: string | null };

const server: T[] = [
  { id: 'a', status: 'SUBMITTED', reviewComment: null, clinicianNotes: 'Nota de ejemplo' },
  { id: 'b', status: 'PENDING', reviewComment: null, clinicianNotes: null },
];
const httpError = (status: number, msg: string) => Object.assign(new Error(msg), { status });

/** Simula el flujo de la página: cambio optimista y luego lo que diga settleTaskUpdate. */
async function run(opts: { patch: () => Promise<unknown>; refresh: () => Promise<T[]>; payload: Partial<T> }) {
  const previous = { ...server[0] };
  let list = applyOptimistic(server, 'a', opts.payload);
  const optimistic = list;
  const result = await settleTaskUpdate<T>({ previous, patch: opts.patch, refresh: opts.refresh, successNotice: 'Tarea completada con tu devolución.' });
  list = result.next(list);
  return { optimistic, list, result };
}

describe('Actualización optimista de tareas', () => {
  it('el cambio se ve al momento en la tarjeta', () => {
    const list = applyOptimistic(server, 'a', { status: 'COMPLETED', reviewComment: 'Gracias.' });
    expect(list[0]).toMatchObject({ status: 'COMPLETED', reviewComment: 'Gracias.' });
    expect(list[1]).toBe(server[1]);
  });

  it.each([403, 400])('PATCH rechazado (%i) → la tarjeta vuelve al estado real del servidor y se muestra ese error', async (status) => {
    const { optimistic, list, result } = await run({
      payload: { status: 'COMPLETED', reviewComment: 'Gracias.' },
      patch: () => Promise.reject(httpError(status, `Error ${status} de ejemplo`)),
      refresh: () => Promise.resolve(server.map((t) => ({ ...t }))),
    });
    expect(optimistic[0].status).toBe('COMPLETED');
    expect(list[0]).toEqual(server[0]);
    expect(result.error).toBe(`Error ${status} de ejemplo`);
    expect(result.notice).toBe('');
  });

  it('PATCH y refresco fallan → restaura la copia previa y muestra el error del PATCH, no el del refresco', async () => {
    const { list, result } = await run({
      payload: { clinicianNotes: 'Texto sin guardar' },
      patch: () => Promise.reject(httpError(403, 'Sin permiso')),
      refresh: () => Promise.reject(new Error('Fallo de red')),
    });
    expect(list[0]).toEqual(server[0]);
    expect(list[0].clinicianNotes).toBe('Nota de ejemplo');
    expect(result.error).toBe('Sin permiso');
  });

  it('PATCH bien y refresco mal → mantiene el cambio guardado y avisa de que la lista no se actualizó', async () => {
    const { list, result } = await run({
      payload: { status: 'COMPLETED' },
      patch: () => Promise.resolve({}),
      refresh: () => Promise.reject(new Error('Fallo de red')),
    });
    expect(list[0].status).toBe('COMPLETED');
    expect(result.error).toBe(REFRESH_FAILED_AFTER_SAVE);
    expect(result.notice).toBe('Tarea completada con tu devolución.');
  });

  it('todo bien → manda la lista del servidor y el aviso de confirmación', async () => {
    const fresh = [{ ...server[0], status: 'COMPLETED', reviewComment: 'Gracias.' }, server[1]];
    const { list, result } = await run({ payload: { status: 'COMPLETED' }, patch: () => Promise.resolve({}), refresh: () => Promise.resolve(fresh) });
    expect(list).toBe(fresh);
    expect(result).toMatchObject({ error: '', notice: 'Tarea completada con tu devolución.' });
  });
});

describe('TaskCardNotes: la nota privada nunca dentro de la devolución', () => {
  const NOTE = 'NOTA-PRIVADA-FICTICIA';
  const REVIEW = 'Gracias. Devolución de ejemplo.';
  const reviewBlock = (html: string) =>
    html.match(/<label class="task-review-field">.*?<\/label>/)?.[0] ?? html.match(/<div class="patient-record-card task-review-readonly">.*?<\/div>/)?.[0] ?? '';

  it.each(['SUBMITTED', 'COMPLETED', 'CHANGES_REQUESTED'] as const)('%s', (status) => {
    const html = renderToStaticMarkup(<TaskCardNotes task={{ id: 'a', status, reviewComment: REVIEW, clinicianNotes: NOTE }} onSaveNote={() => undefined} />);
    const block = reviewBlock(html);
    expect(block).toContain(REVIEW);
    expect(block).not.toContain(NOTE);
    expect(block).not.toContain('Nota clínica privada');
    expect(html.match(/<label class="task-private-note">.*?<\/label>/)?.[0]).toContain(NOTE);
  });

  it('sin devolución no pinta el bloque de devolución en una tarea ya revisada', () => {
    const html = renderToStaticMarkup(<TaskCardNotes task={{ id: 'a', status: 'COMPLETED', reviewComment: null, clinicianNotes: NOTE }} onSaveNote={() => undefined} />);
    expect(html).not.toContain('Devolución');
  });
});
