/**
 * Actualización optimista de una tarea terapéutica (pantalla de Tareas del profesional).
 *
 * 1. `applyOptimistic` cambia la tarjeta al momento.
 * 2. `settleTaskUpdate` hace el PATCH y vuelve a pedir la lista:
 *    - si el refresco funciona, manda el estado real del servidor (también cuando el PATCH falló);
 *    - si el PATCH falló y el refresco también, se restaura la copia previa de la tarea;
 *    - si el PATCH fue bien y el refresco falla, se mantiene el cambio (ya está guardado).
 *    El error que se muestra es siempre el del PATCH; el del refresco solo si el PATCH fue bien.
 */
export type TaskLike = { id: string };

export function applyOptimistic<T extends TaskLike>(list: T[], id: string, payload: Partial<T>): T[] {
  return list.map((t) => (t.id === id ? { ...t, ...payload } : t));
}

export type TaskUpdateResult<T> = {
  /** Cómo dejar la lista tras el intento (se aplica con setTasks(list => next(list))). */
  next: (list: T[]) => T[];
  /** Mensaje de error para la persona ('' si no hay). */
  error: string;
  /** Aviso de confirmación ('' si hubo error en el guardado). */
  notice: string;
};

const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

export const REFRESH_FAILED_AFTER_SAVE = 'Cambios guardados, pero no se pudo actualizar la lista. Recarga la página para ver el estado más reciente.';

export async function settleTaskUpdate<T extends TaskLike>({
  previous,
  patch,
  refresh,
  successNotice,
}: {
  /** Copia de la tarea tal como estaba antes del cambio optimista. */
  previous: T;
  patch: () => Promise<unknown>;
  refresh: () => Promise<T[]>;
  successNotice: string;
}): Promise<TaskUpdateResult<T>> {
  let patchError = '';
  try {
    await patch();
  } catch (err) {
    patchError = message(err, 'No se pudo actualizar la tarea');
  }

  let refreshed: T[] | null = null;
  try {
    refreshed = await refresh();
  } catch {
    refreshed = null;
  }

  if (refreshed) {
    const fresh = refreshed;
    return { next: () => fresh, error: patchError, notice: patchError ? '' : successNotice };
  }
  if (patchError) {
    return { next: (list) => list.map((t) => (t.id === previous.id ? previous : t)), error: patchError, notice: '' };
  }
  return { next: (list) => list, error: REFRESH_FAILED_AFTER_SAVE, notice: successNotice };
}
