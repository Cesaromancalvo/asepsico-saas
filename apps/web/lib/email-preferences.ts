/*
 * «Mi cuenta → Avisos por email» (N4): qué emails de aviso recibe el propio usuario en su espacio actual.
 *
 * API (tipos en @asepsico/contracts):
 *   GET   /notifications/email-preferences → StaffEmailPreferencesResponse
 *   PATCH /notifications/email-preferences → StaffEmailPreferencesResponse (cliente `api`: cookies + CSRF)
 *
 * Nada se guarda en el navegador. La pantalla solo muestra las opciones con `available: true`
 * (recepción no ve «Tareas entregadas»); la API además lo rechaza con 403.
 *
 * Esta ruta es fija: la enlazan los pies de los emails al equipo (STAFF_EMAIL_SETTINGS_PATH en la API).
 */
import type { StaffEmailKind, StaffEmailPreference, StaffEmailPreferencesResponse, StaffEmailPreferencesUpdate } from '@asepsico/contracts';
import { api, ApiError } from './api';

export type { StaffEmailKind, StaffEmailPreference, StaffEmailPreferencesResponse };

export const EMAIL_NOTIFICATIONS_PATH = '/settings/email-notifications';

export const EMAIL_KIND_ORDER: readonly StaffEmailKind[] = ['appointmentRequests', 'patientCancellations', 'taskSubmitted'];

export const EMAIL_KIND_TEXT: Record<StaffEmailKind, { label: string; hint: string }> = {
  appointmentRequests: {
    label: 'Solicitudes de cita',
    hint: 'Cuando un paciente pide cita desde su portal.',
  },
  patientCancellations: {
    label: 'Cancelaciones de pacientes',
    hint: 'Cuando un paciente cancela una cita o retira una solicitud desde su portal.',
  },
  taskSubmitted: {
    label: 'Tareas entregadas',
    hint: 'Cuando un paciente te entrega una tarea. Viene apagado.',
  },
};

/** Línea de privacidad y horario (spec §4.2). */
export const EMAIL_PRIVACY_LINE =
  'El email solo te avisa de que hay algo nuevo: no incluye nombres ni datos de pacientes, y nunca se envía entre las 21:00 y las 07:00 (lo de la noche te llega a las 07:00 en un solo correo).';

/** Opciones que se muestran, en orden fijo. Las no disponibles para el rol no aparecen. */
export function visibleKinds(preferences: Partial<Record<StaffEmailKind, StaffEmailPreference>> | null | undefined): StaffEmailKind[] {
  if (!preferences) return [];
  return EMAIL_KIND_ORDER.filter((kind) => preferences[kind]?.available === true);
}

export function defaultBadge(pref: StaffEmailPreference): string {
  return pref.isDefault ? 'Valor por defecto' : 'Elegido por ti';
}

export async function fetchEmailPreferences(): Promise<StaffEmailPreferencesResponse> {
  return api<StaffEmailPreferencesResponse>('/notifications/email-preferences');
}

/** Guarda un solo interruptor (solo se envía la clave que cambia). */
export async function updateEmailPreference(kind: StaffEmailKind, enabled: boolean): Promise<StaffEmailPreferencesResponse> {
  const body: StaffEmailPreferencesUpdate = { [kind]: enabled };
  return api<StaffEmailPreferencesResponse>('/notifications/email-preferences', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** Texto de error del guardado, sin repetir mensajes técnicos. */
export function saveErrorMessage(kind: StaffEmailKind, err: unknown): string {
  const label = EMAIL_KIND_TEXT[kind].label;
  if (err instanceof ApiError && err.status === 403) return `Tu rol no permite cambiar «${label}».`;
  if (err instanceof ApiError && err.status === 429) return err.message;
  return `No se ha podido guardar «${label}». Comprueba la conexión y vuelve a intentarlo.`;
}

export function loadErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return 'Tu cuenta no tiene avisos por email en este espacio.';
  return 'No hemos podido cargar tus avisos por email. Comprueba la conexión y vuelve a intentarlo.';
}
