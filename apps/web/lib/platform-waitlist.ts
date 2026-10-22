'use client';

import { useEffect, useState } from 'react';
import type {
  PlatformMeResponse,
  PlatformWaitlistCommercialContract,
  PlatformWaitlistCounters,
  PlatformWaitlistEncryptedField,
  PlatformWaitlistEntryContract,
  PlatformWaitlistResponse,
  WaitlistSituation,
  WaitlistSource,
} from '@asepsico/contracts';
import { PLATFORM_WAITLIST_UNSPECIFIED } from '@asepsico/contracts';
import { api, ApiError } from './api';

/**
 * Panel privado de la lista de espera (/admin/lista-espera). Contrato:
 * packages/contracts/src/platform-waitlist.ts.
 *
 * Reglas de la web (spec de Vega §3 y criterio 13):
 *  - Solo la API decide quién es PLATFORM_ADMIN. La web únicamente esconde el enlace y, si la API
 *    responde 404, muestra la página 404 normal (sin pistas).
 *  - Nada de estos datos se guarda en localStorage, sessionStorage, IndexedDB ni en la URL; las
 *    peticiones van con cache: 'no-store' y los filtros viven solo en memoria.
 *  - El guard del panel convierte también una sesión caducada en 404. Por eso, antes de pedir la
 *    lista o de suprimir, se llama a GET /admin/me (que sí da 401 y deja que el cliente renueve la
 *    sesión): así un token caducado no se confunde con "no existe".
 */

export const PANEL_PATH = '/admin/lista-espera';
const NO_STORE: RequestInit = { cache: 'no-store' };

export type Entry = PlatformWaitlistEntryContract;
export type SourceKey = WaitlistSource | typeof PLATFORM_WAITLIST_UNSPECIFIED;
export type SituationKey = WaitlistSituation | typeof PLATFORM_WAITLIST_UNSPECIFIED;

export const SOURCE_LABEL: Record<SourceKey, string> = {
  INSTAGRAM: 'Instagram',
  COLLEAGUE: 'Compañero/a',
  PROFESSIONAL_COLLEGE: 'Colegio profesional',
  SEARCH_ENGINE: 'Buscador',
  OTHER: 'Otro',
  NOT_SAID: 'Prefiere no decirlo',
  UNSPECIFIED: 'No indicado',
};
export const SOURCE_ORDER: SourceKey[] = ['INSTAGRAM', 'COLLEAGUE', 'PROFESSIONAL_COLLEGE', 'SEARCH_ENGINE', 'OTHER', 'NOT_SAID', 'UNSPECIFIED'];

export const SITUATION_LABEL: Record<SituationKey, string> = {
  SELF_EMPLOYED: 'Autónomo/a',
  PRACTICE: 'Consulta o clínica',
  STUDENT: 'Estudiante',
  OTHER: 'Otra',
  UNSPECIFIED: 'Sin dato',
};
export const SITUATION_ORDER: SituationKey[] = ['SELF_EMPLOYED', 'PRACTICE', 'STUDENT', 'OTHER', 'UNSPECIFIED'];

export const UNREADABLE = 'No legible';
export const TOOLS_MAX_CHARS = 60;

/* ------------------------------- Acceso ------------------------------- */

let meCache: Promise<boolean> | null = null;

/**
 * ¿Es PLATFORM_ADMIN? Solo para decidir si se pinta el enlace de la barra lateral. Cualquier error
 * cuenta como "no" (fallo cerrado) y no se cachea, para poder reintentar en la siguiente pantalla.
 */
export function fetchIsPlatformAdmin(): Promise<boolean> {
  if (meCache) return meCache;
  const pending = api<PlatformMeResponse>('/admin/me', NO_STORE)
    .then((me) => me?.platformAdmin === true)
    .catch(() => { meCache = null; return false; });
  meCache = pending;
  return pending;
}

export function invalidatePlatformAdmin() {
  meCache = null;
}

/** `false` mientras se carga o si no es admin: el enlace nunca aparece "por si acaso". */
export function usePlatformAdmin(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchIsPlatformAdmin().then((value) => { if (!cancelled) setAdmin(value); });
    return () => { cancelled = true; };
  }, []);
  return admin;
}

/* ------------------------------- Carga ------------------------------- */

export type PanelLoad = { kind: 'ready'; data: PlatformWaitlistResponse } | { kind: 'notFound' };

/** 401/403/404 → la ruta "no existe" para quien la pide. Red o 5xx → error con reintento. */
export function isHiddenError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404);
}

export async function loadPanel(): Promise<PanelLoad> {
  try {
    const me = await api<PlatformMeResponse>('/admin/me', NO_STORE);
    if (me?.platformAdmin !== true) return { kind: 'notFound' };
    const data = await api<PlatformWaitlistResponse>('/admin/waitlist', NO_STORE);
    return { kind: 'ready', data };
  } catch (err) {
    if (isHiddenError(err)) return { kind: 'notFound' };
    throw err;
  }
}

/**
 * Suprime un alta con la contraseña del PLATFORM_ADMIN (POST con CSRF, 204). Primero asegura una
 * sesión vigente con /admin/me: si no, un token caducado daría 404 y parecería que el alta no existe.
 */
export async function suppressEntry(id: string, password: string): Promise<void> {
  await api<PlatformMeResponse>('/admin/me', NO_STORE);
  await api<void>(`/admin/waitlist/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify({ password }),
  });
}

/** Mensaje para el diálogo de supresión. La contraseña nunca aparece en él. */
export function suppressErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 && err.code === 'PLATFORM_REAUTH_FAILED') return 'La contraseña no es correcta. No se ha suprimido nada.';
    if (err.status === 404) return 'Esta alta ya no existe: puede que ya se haya suprimido. Cierra y recarga la lista.';
    if (err.status === 429) return 'Demasiados intentos seguidos. Espera un minuto y vuelve a intentarlo.';
    if (err.status === 400) return 'Escribe tu contraseña para confirmar.';
  }
  return 'No se ha podido suprimir el alta. Comprueba la conexión y vuelve a intentarlo.';
}

/* ------------------------------- Formato ------------------------------- */

const dateTime = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Madrid' });
const dayMonth = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Madrid' });
const shortDay = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** dd/mm/aaaa hh:mm en hora de Madrid. */
export function formatSignupDate(iso: string): string {
  return dateTime.format(new Date(iso)).replace(',', '');
}

export function commercialLabel(commercial: PlatformWaitlistCommercialContract): string {
  const at = commercial.at ? dayMonth.format(new Date(commercial.at)) : '';
  switch (commercial.status) {
    case 'REQUESTED_UNCONFIRMED': return 'Solicitado (sin confirmar)';
    case 'VALID': return at ? `Válido desde ${at}` : 'Válido';
    case 'WITHDRAWN': return at ? `Retirado ${at}` : 'Retirado';
    default: return '—';
  }
}

export function commercialTone(commercial: PlatformWaitlistCommercialContract): 'none' | 'amber' | 'green' | 'neutral' {
  if (commercial.status === 'REQUESTED_UNCONFIRMED') return 'amber';
  if (commercial.status === 'VALID') return 'green';
  if (commercial.status === 'WITHDRAWN') return 'neutral';
  return 'none';
}

export type FieldView = { text: string; unreadable: boolean; title?: string };

/** Nombre, email o herramientas: "No legible" si la API no pudo descifrarlo; "—" si no se indicó. */
export function fieldView(entry: Entry, field: PlatformWaitlistEncryptedField): FieldView {
  if (entry.unreadableFields.includes(field)) return { text: UNREADABLE, unreadable: true };
  const value = entry[field];
  if (value == null || value === '') return { text: '—', unreadable: false };
  if (field === 'tools' && value.length > TOOLS_MAX_CHARS) {
    return { text: `${value.slice(0, TOOLS_MAX_CHARS - 1).trimEnd()}…`, unreadable: false, title: value };
  }
  return { text: value, unreadable: false };
}

export const sourceKey = (entry: Entry): SourceKey => entry.source ?? PLATFORM_WAITLIST_UNSPECIFIED;
export const situationKey = (entry: Entry): SituationKey => entry.situation ?? PLATFORM_WAITLIST_UNSPECIFIED;

/** Lunes (UTC) de una semana ISO "2026-W43". */
export function isoWeekMonday(isoWeek: string): Date | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  return new Date(Date.UTC(year, 0, 4 - jan4Day + 1 + (week - 1) * 7));
}

/** "Semana 43 · 19–25 oct." */
export function weekLabel(isoWeek: string): string {
  const monday = isoWeekMonday(isoWeek);
  if (!monday) return isoWeek;
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const number = Number(isoWeek.slice(-2));
  const from = shortDay.format(monday);
  const to = shortDay.format(sunday);
  const sameMonth = monday.getUTCMonth() === sunday.getUTCMonth();
  return `Semana ${number} · ${sameMonth ? `${monday.getUTCDate()}–${to}` : `${from} – ${to}`}`;
}

/** Etiqueta corta para las barras semanales: "19 oct". */
export function weekStartShort(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  const month = new Intl.DateTimeFormat('es-ES', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  return `${d} ${month.replace('.', '').slice(0, 3)}`;
}

/* ------------------------------- Filtros (solo en memoria) ------------------------------- */

export type Filters = { sources: SourceKey[]; situations: SituationKey[]; week: string };
export const EMPTY_FILTERS: Filters = { sources: [], situations: [], week: '' };

export function hasFilters(filters: Filters): boolean {
  return filters.sources.length > 0 || filters.situations.length > 0 || filters.week !== '';
}

export function applyFilters(entries: Entry[], filters: Filters): Entry[] {
  return entries.filter((entry) =>
    (filters.sources.length === 0 || filters.sources.includes(sourceKey(entry))) &&
    (filters.situations.length === 0 || filters.situations.includes(situationKey(entry))) &&
    (filters.week === '' || entry.isoWeek === filters.week));
}

/** Semanas con altas, de la más reciente a la más antigua (opciones del selector). */
export function weekOptions(entries: Entry[]): string[] {
  return [...new Set(entries.map((entry) => entry.isoWeek))].sort((a, b) => b.localeCompare(a));
}

export function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** Tras suprimir: se quita la fila y los contadores se recalculan sin volver a pedir datos. */
export function withoutEntry(data: PlatformWaitlistResponse, id: string): PlatformWaitlistResponse {
  const removed = data.entries.find((entry) => entry.id === id);
  if (!removed) return data;
  const counters: PlatformWaitlistCounters = {
    totalActive: Math.max(0, data.counters.totalActive - 1),
    weekly: data.counters.weekly.map((week) => (week.isoWeek === removed.isoWeek ? { ...week, count: Math.max(0, week.count - 1) } : week)),
    bySource: { ...data.counters.bySource, [sourceKey(removed)]: Math.max(0, data.counters.bySource[sourceKey(removed)] - 1) },
    bySituation: { ...data.counters.bySituation, [situationKey(removed)]: Math.max(0, data.counters.bySituation[situationKey(removed)] - 1) },
  };
  return {
    ...data,
    entries: data.entries.filter((entry) => entry.id !== id),
    counters,
    unreadable: data.unreadable - (removed.unreadableFields.length > 0 ? 1 : 0),
  };
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
