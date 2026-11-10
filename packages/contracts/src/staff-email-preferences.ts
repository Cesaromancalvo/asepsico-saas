/**
 * Avisos por email del propio usuario del equipo (N4), en su espacio actual.
 *
 *   GET   /api/v1/notifications/email-preferences → StaffEmailPreferencesResponse
 *   PATCH /api/v1/notifications/email-preferences → StaffEmailPreferencesResponse (con CSRF)
 *         cuerpo: StaffEmailPreferencesUpdate (solo las claves que cambian)
 *
 * Solo el propio usuario: nunca las de otro miembro. ASSISTANT no tiene `taskSubmitted`
 * (available:false y la API responde 403 si intenta cambiarlo).
 */
export type StaffEmailKind = 'appointmentRequests' | 'patientCancellations' | 'taskSubmitted';

export interface StaffEmailPreference {
  /** Valor efectivo (elección expresa o, si no la hay, el valor por defecto de su rol). */
  enabled: boolean;
  /** true si no ha elegido nada y se aplica el valor por defecto. */
  isDefault: boolean;
  /** false si su rol no puede recibir este tipo de email (la opción no se muestra). */
  available: boolean;
}

export interface StaffEmailPreferencesResponse {
  workspaceId: string;
  preferences: Record<StaffEmailKind, StaffEmailPreference>;
}

export type StaffEmailPreferencesUpdate = Partial<Record<StaffEmailKind, boolean>>;
