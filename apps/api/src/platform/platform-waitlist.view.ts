/**
 * Tipos de respuesta: COPIA de packages/contracts/src/platform-waitlist.ts (la API no depende del
 * paquete de contratos, igual que en el resto de módulos). Si cambias uno, cambia el otro.
 */
type WaitlistSituation = 'SELF_EMPLOYED' | 'PRACTICE' | 'STUDENT' | 'OTHER';
type WaitlistSource = 'INSTAGRAM' | 'COLLEAGUE' | 'PROFESSIONAL_COLLEGE' | 'SEARCH_ENGINE' | 'OTHER' | 'NOT_SAID';
export type PlatformWaitlistCommercialStatus = 'NONE' | 'REQUESTED_UNCONFIRMED' | 'VALID' | 'WITHDRAWN';
export interface PlatformWaitlistCommercialContract { status: PlatformWaitlistCommercialStatus; at: string | null }
export type PlatformWaitlistEncryptedField = 'name' | 'email' | 'tools' | 'phone';
export interface PlatformWaitlistEntryContract {
  id: string; createdAt: string; isoWeek: string; name: string | null; email: string | null; phone: string | null;
  situation: WaitlistSituation | null; professionalsCount: number | null; tools: string | null;
  source: WaitlistSource | null; privacyPolicyVersion: string; commercial: PlatformWaitlistCommercialContract;
  unreadableFields: PlatformWaitlistEncryptedField[];
}
export interface PlatformWaitlistWeekCount { isoWeek: string; weekStart: string; count: number }
export interface PlatformWaitlistCounters {
  totalActive: number; withoutPhone: number; weekly: PlatformWaitlistWeekCount[];
  bySource: Record<WaitlistSource | 'UNSPECIFIED', number>; bySituation: Record<WaitlistSituation | 'UNSPECIFIED', number>;
}
export interface PlatformWaitlistResponse { entries: PlatformWaitlistEntryContract[]; counters: PlatformWaitlistCounters; unreadable: number; generatedAt: string }

import { decryptModel } from '../common/crypto/clinical-crypto';
import { DECRYPTION_FAILED_PLACEHOLDER } from '../common/crypto/field-encryption';

/**
 * Lógica pura del panel (sin BD) para poder probarla: descifrado tolerante, estado comercial y
 * contadores por semana ISO en hora de Madrid. Nunca registra valores.
 */

export const PLATFORM_WAITLIST_TIME_ZONE = 'Europe/Madrid';
export const PLATFORM_WAITLIST_WEEKS = 8;

const SOURCES = ['INSTAGRAM', 'COLLEAGUE', 'PROFESSIONAL_COLLEGE', 'SEARCH_ENGINE', 'OTHER', 'NOT_SAID'] as const;
const SITUATIONS = ['SELF_EMPLOYED', 'PRACTICE', 'STUDENT', 'OTHER'] as const;
const ENCRYPTED: readonly PlatformWaitlistEncryptedField[] = ['name', 'email', 'tools', 'phone'];
const DAY_MS = 86_400_000;

/** Columnas que se leen de WaitlistEntry (nunca emailHash). */
export const PLATFORM_WAITLIST_SELECT = {
  id: true,
  createdAt: true,
  name: true,
  email: true,
  phone: true,
  situation: true,
  professionalsCount: true,
  tools: true,
  source: true,
  privacyPolicyVersion: true,
  commercialConsentRequested: true,
  commercialConsentRequestedAt: true,
  commercialConsent: true,
  commercialConsentAt: true,
  commercialConsentWithdrawnAt: true,
} as const;

export interface WaitlistRow {
  id: string;
  createdAt: Date;
  name: string | null;
  email: string | null;
  phone: string | null;
  situation: string | null;
  professionalsCount: number | null;
  tools: string | null;
  source: string | null;
  privacyPolicyVersion: string;
  commercialConsentRequested: boolean;
  commercialConsentRequestedAt: Date | null;
  commercialConsent: boolean;
  commercialConsentAt: Date | null;
  commercialConsentWithdrawnAt: Date | null;
}

const madridDay = new Intl.DateTimeFormat('en-CA', { timeZone: PLATFORM_WAITLIST_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Día del calendario de Madrid como medianoche UTC de ese día (aritmética de fechas sin zona). */
function madridCalendarDay(instant: Date): Date {
  const [y, m, d] = madridDay.format(instant).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const ymd = (day: Date) => day.toISOString().slice(0, 10);

/** Semana ISO 8601 (lunes a domingo) de un día de calendario. */
export function isoWeekOfDay(day: Date): { isoWeek: string; weekStart: string; monday: Date } {
  const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY_MS);
  const week = 1 + Math.round((monday.getTime() - week1Monday.getTime()) / (7 * DAY_MS));
  return { isoWeek: `${isoYear}-W${String(week).padStart(2, '0')}`, weekStart: ymd(monday), monday };
}

/** Semana ISO de un instante, en hora de Madrid. */
export function madridIsoWeek(instant: Date) {
  return isoWeekOfDay(madridCalendarDay(instant));
}

/** Las últimas `weeks` semanas ISO de Madrid, de la más antigua a la actual (incluida). */
export function lastMadridWeeks(now: Date, weeks = PLATFORM_WAITLIST_WEEKS): { isoWeek: string; weekStart: string }[] {
  const { monday } = madridIsoWeek(now);
  return Array.from({ length: weeks }, (_, i) => {
    const { isoWeek, weekStart } = isoWeekOfDay(new Date(monday.getTime() - (weeks - 1 - i) * 7 * DAY_MS));
    return { isoWeek, weekStart };
  });
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Retirada > válido > solicitado sin confirmar > nada (withdraw deja requested=false y consent=false). */
export function commercialStatus(row: Pick<WaitlistRow, 'commercialConsentRequested' | 'commercialConsentRequestedAt' | 'commercialConsent' | 'commercialConsentAt' | 'commercialConsentWithdrawnAt'>): PlatformWaitlistCommercialContract {
  if (row.commercialConsent) return { status: 'VALID', at: iso(row.commercialConsentAt) };
  if (row.commercialConsentWithdrawnAt) return { status: 'WITHDRAWN', at: iso(row.commercialConsentWithdrawnAt) };
  if (row.commercialConsentRequested) return { status: 'REQUESTED_UNCONFIRMED', at: iso(row.commercialConsentRequestedAt) };
  return { status: 'NONE', at: null };
}

export function toEntry(raw: WaitlistRow): PlatformWaitlistEntryContract {
  const row = decryptModel('waitlistEntry', raw as unknown as Record<string, unknown>) as unknown as WaitlistRow;
  const unreadableFields = ENCRYPTED.filter((field) => row[field] === DECRYPTION_FAILED_PLACEHOLDER);
  const readable = (field: PlatformWaitlistEncryptedField) => (unreadableFields.includes(field) ? null : (row[field] ?? null));
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    isoWeek: madridIsoWeek(row.createdAt).isoWeek,
    name: readable('name'),
    email: readable('email'),
    phone: readable('phone'),
    situation: (row.situation ?? null) as PlatformWaitlistEntryContract['situation'],
    professionalsCount: row.professionalsCount ?? null,
    tools: readable('tools'),
    source: (row.source ?? null) as PlatformWaitlistEntryContract['source'],
    privacyPolicyVersion: row.privacyPolicyVersion,
    commercial: commercialStatus(row),
    unreadableFields,
  };
}

export function buildCounters(entries: PlatformWaitlistEntryContract[], now: Date): PlatformWaitlistCounters {
  const bySource = Object.fromEntries([...SOURCES, 'UNSPECIFIED'].map((k) => [k, 0])) as PlatformWaitlistCounters['bySource'];
  const bySituation = Object.fromEntries([...SITUATIONS, 'UNSPECIFIED'].map((k) => [k, 0])) as PlatformWaitlistCounters['bySituation'];
  const weekly: PlatformWaitlistWeekCount[] = lastMadridWeeks(now).map((w) => ({ ...w, count: 0 }));
  const weekIndex = new Map(weekly.map((w, i) => [w.isoWeek, i]));
  for (const entry of entries) {
    bySource[entry.source ?? 'UNSPECIFIED'] += 1;
    bySituation[entry.situation ?? 'UNSPECIFIED'] += 1;
    const i = weekIndex.get(entry.isoWeek);
    if (i !== undefined) weekly[i].count += 1;
  }
  // Sin teléfono = null de verdad (altas v2–v4 o teléfono borrado), no las filas con el teléfono ilegible.
  const withoutPhone = entries.filter((e) => e.phone === null && !e.unreadableFields.includes('phone')).length;
  return { totalActive: entries.length, withoutPhone, weekly, bySource, bySituation };
}

export function buildWaitlistResponse(rows: WaitlistRow[], now: Date): PlatformWaitlistResponse {
  const entries = rows.map(toEntry);
  return {
    entries,
    counters: buildCounters(entries, now),
    unreadable: entries.filter((e) => e.unreadableFields.length > 0).length,
    generatedAt: now.toISOString(),
  };
}
