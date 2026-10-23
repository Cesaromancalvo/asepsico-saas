/**
 * Panel privado de la lista de espera (capacidad de plataforma PLATFORM_ADMIN).
 * Implementación: apps/api/src/platform/. Web: ruta /admin/lista-espera.
 *
 * Quién es PLATFORM_ADMIN: SOLO la API lo decide (variable PLATFORM_ADMIN_EMAILS + MFA activo en
 * la cuenta y en la sesión). No hay endpoint, pantalla ni seed que lo conceda. No da acceso a
 * ningún workspace ni a datos clínicos.
 *
 * Endpoints (sesión normal de la app por cookies; los POST llevan además x-csrf-token):
 *  - GET  /api/v1/admin/me                  → 200 PlatformMeResponse (cualquier usuario autenticado;
 *                                             401 sin sesión). La web solo enseña el enlace al panel
 *                                             si platformAdmin === true.
 *  - GET  /api/v1/admin/waitlist            → 200 PlatformWaitlistResponse
 *  - POST /api/v1/admin/waitlist/:id/delete  body PlatformWaitlistDeleteRequest
 *                                           → 204 sin cuerpo (alta suprimida)
 *                                           → 401 PlatformReauthErrorResponse (contraseña incorrecta)
 *                                           → 404 alta inexistente o ya suprimida
 *                                           → 400 validación · 429 demasiados intentos
 *
 * Para cualquiera que NO sea PLATFORM_ADMIN (también sin sesión, con MFA desactivado o con la
 * variable vacía) /admin/waitlist* responde 404 como una ruta que no existe: la web debe mostrar
 * su página 404 normal, sin pistas.
 *
 * Todas las respuestas llevan Cache-Control: no-store. La web NO debe guardar estos datos en
 * localStorage, sessionStorage, IndexedDB ni analítica, ni ponerlos en la URL.
 */

import type { WaitlistSituation, WaitlistSource } from './waitlist';

export interface PlatformMeResponse {
  platformAdmin: boolean;
}

/**
 * Estado del consentimiento comercial de un alta:
 *  - NONE: no se pidió (columna "—"; siempre en las altas v3).
 *  - REQUESTED_UNCONFIRMED: casilla marcada en el formulario v2, sin doble opt-in ("Solicitado (sin confirmar)").
 *  - VALID: confirmado con waitlist:confirm-commercial ("Válido desde dd/mm").
 *  - WITHDRAWN: retirado ("Retirado dd/mm").
 */
export type PlatformWaitlistCommercialStatus = 'NONE' | 'REQUESTED_UNCONFIRMED' | 'VALID' | 'WITHDRAWN';

export interface PlatformWaitlistCommercialContract {
  status: PlatformWaitlistCommercialStatus;
  /**
   * ISO 8601 (UTC). REQUESTED_UNCONFIRMED: cuándo se marcó la casilla; VALID: desde cuándo es
   * válido; WITHDRAWN: cuándo se retiró; NONE: null.
   */
  at: string | null;
}

/** Campos cifrados que pueden no poderse descifrar (la web muestra "No legible"). */
export type PlatformWaitlistEncryptedField = 'name' | 'email' | 'tools';

/** Una alta ACTIVA (las suprimidas nunca se devuelven). Orden: más reciente primero. */
export interface PlatformWaitlistEntryContract {
  id: string;
  /** ISO 8601 (UTC). La web lo muestra como dd/mm/aaaa hh:mm en Europe/Madrid. */
  createdAt: string;
  /** Semana ISO del alta en hora de Madrid, p. ej. "2026-W43" (para el filtro por semana). */
  isoWeek: string;
  /** null si no se pudo descifrar (ver unreadableFields). */
  name: string | null;
  /** null si no se pudo descifrar (ver unreadableFields). */
  email: string | null;
  situation: WaitlistSituation | null;
  professionalsCount: number | null;
  /** Texto descifrado (la web lo trunca a 60 caracteres con tooltip). null si no lo indicó o no es legible. */
  tools: string | null;
  source: WaitlistSource | null;
  privacyPolicyVersion: string;
  commercial: PlatformWaitlistCommercialContract;
  /** Campos que no se han podido descifrar en esta fila (vacío si todo es legible). */
  unreadableFields: PlatformWaitlistEncryptedField[];
}

/** Clave para las altas sin dato (source o situation vacíos). */
export const PLATFORM_WAITLIST_UNSPECIFIED = 'UNSPECIFIED';
export type PlatformWaitlistUnspecified = typeof PLATFORM_WAITLIST_UNSPECIFIED;

export interface PlatformWaitlistWeekCount {
  /** Semana ISO en hora de Madrid, p. ej. "2026-W43". */
  isoWeek: string;
  /** Lunes de esa semana (YYYY-MM-DD, calendario de Madrid). */
  weekStart: string;
  count: number;
}

export interface PlatformWaitlistCounters {
  /** Altas activas (deletedAt = null). */
  totalActive: number;
  /** Últimas 8 semanas ISO (lunes a domingo, Europe/Madrid), de la más antigua a la actual (incluida). Siempre 8 elementos. */
  weekly: PlatformWaitlistWeekCount[];
  /** Todas las claves siempre presentes (0 si no hay altas). UNSPECIFIED = no se indicó origen. */
  bySource: Record<WaitlistSource | PlatformWaitlistUnspecified, number>;
  /** Todas las claves siempre presentes (0 si no hay altas). UNSPECIFIED = sin dato. */
  bySituation: Record<WaitlistSituation | PlatformWaitlistUnspecified, number>;
}

/** GET /api/v1/admin/waitlist. El MVP devuelve todas las activas; los filtros se aplican en la web. */
export interface PlatformWaitlistResponse {
  entries: PlatformWaitlistEntryContract[];
  counters: PlatformWaitlistCounters;
  /** Número de filas con al menos un campo no legible. */
  unreadable: number;
  /** ISO 8601 (UTC): momento en que la API generó la respuesta. */
  generatedAt: string;
}

/** POST /api/v1/admin/waitlist/:id/delete — reautenticación con la contraseña del PLATFORM_ADMIN. */
export interface PlatformWaitlistDeleteRequest {
  password: string;
}

/** 401 de la supresión cuando la contraseña no es correcta (no se ha cambiado nada). */
export interface PlatformReauthErrorResponse {
  statusCode: 401;
  code: 'PLATFORM_REAUTH_FAILED';
  message: string;
}
