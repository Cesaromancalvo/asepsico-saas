/*
 * «Ver en la agenda» desde un aviso: qué cita resaltar al llegar a /agenda.
 *
 * Se pasa en memoria (variable del módulo, sobrevive a la navegación del cliente de Next) y no por
 * la URL ni por localStorage: ni el id de la cita ni su fecha quedan en el historial, en marcadores
 * o en el navegador. Se consume una sola vez; si se recarga la página, la agenda abre en la semana
 * actual, sin resaltar nada. Caduca a los 30 s por si la navegación no llega a producirse.
 */
type AgendaFocus = { sessionId: string; startsAt: string; at: number };

let pending: AgendaFocus | null = null;
const TTL_MS = 30_000;

/** Para la agenda ya abierta: navegar a la misma ruta no la vuelve a montar. */
export const AGENDA_FOCUS_EVENT = 'asepsico:agenda-focus';

export function setAgendaFocus(sessionId: string, startsAt: string) {
  pending = { sessionId, startsAt, at: Date.now() };
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AGENDA_FOCUS_EVENT));
}

/** Devuelve la cita a resaltar (y la olvida), o null. */
export function takeAgendaFocus(now: number = Date.now()): { sessionId: string; startsAt: string } | null {
  const focus = pending;
  pending = null;
  if (!focus || now - focus.at > TTL_MS || Number.isNaN(new Date(focus.startsAt).getTime())) return null;
  return { sessionId: focus.sessionId, startsAt: focus.startsAt };
}
