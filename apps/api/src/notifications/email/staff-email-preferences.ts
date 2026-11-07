import { StaffTemplate } from './email-templates';

/**
 * Preferencias de email del equipo (N4) y valores por defecto por rol (spec §7).
 *
 * En NotificationPreference (una fila por workspaceId + userId) los tres campos son nullable:
 * null = «por defecto», true/false = elección expresa del propio usuario.
 */

export type StaffEmailKind = 'appointmentRequests' | 'patientCancellations' | 'taskSubmitted';
export const STAFF_EMAIL_KINDS: readonly StaffEmailKind[] = ['appointmentRequests', 'patientCancellations', 'taskSubmitted'];

export const KIND_FIELD: Record<StaffEmailKind, 'emailAppointmentRequests' | 'emailPatientCancellations' | 'emailTaskSubmitted'> = {
  appointmentRequests: 'emailAppointmentRequests',
  patientCancellations: 'emailPatientCancellations',
  taskSubmitted: 'emailTaskSubmitted',
};

export const KIND_TEMPLATE: Record<StaffEmailKind, StaffTemplate> = {
  appointmentRequests: 'STAFF_APPOINTMENT_REQUEST',
  patientCancellations: 'STAFF_PATIENT_CANCELLATION',
  taskSubmitted: 'STAFF_TASK_SUBMITTED',
};

export const TEMPLATE_KIND: Record<StaffTemplate, StaffEmailKind> = {
  STAFF_APPOINTMENT_REQUEST: 'appointmentRequests',
  STAFF_PATIENT_CANCELLATION: 'patientCancellations',
  STAFF_TASK_SUBMITTED: 'taskSubmitted',
};

/**
 * Recepción (ASSISTANT) recibe por defecto las solicitudes nuevas y las cancelaciones.
 * PENDIENTE DE CONFIRMAR POR EL JEFE (spec §9.2): si decide que solo le llegue al profesional,
 * basta con poner esto a false (cambia el defecto, no el diseño; quien lo encendió a mano lo conserva).
 */
export const ASSISTANT_RECEIVES_APPOINTMENT_EMAILS_BY_DEFAULT = true;

type Role = 'OWNER' | 'ADMIN' | 'THERAPIST' | 'ASSISTANT' | string;

/** ¿Puede este rol recibir este tipo de email? (ASSISTANT nunca recibe nada de tareas.) */
export function kindAllowedForRole(kind: StaffEmailKind, role: Role): boolean {
  if (kind === 'taskSubmitted') return role !== 'ASSISTANT';
  return ['OWNER', 'ADMIN', 'THERAPIST', 'ASSISTANT'].includes(role);
}

/**
 * Valor por defecto. `isProfessional` = el usuario es el profesional de la cita/solicitud/tarea.
 * Para la pantalla «Mi cuenta» (sin cita concreta) se usa el valor de cuando sí lo es.
 */
export function defaultFor(kind: StaffEmailKind, role: Role, isProfessional: boolean): boolean {
  if (!kindAllowedForRole(kind, role)) return false;
  if (kind === 'taskSubmitted') return false; // N3 apagado por defecto para todos
  if (role === 'ASSISTANT') return ASSISTANT_RECEIVES_APPOINTMENT_EMAILS_BY_DEFAULT;
  if (role === 'THERAPIST') return isProfessional;
  return isProfessional; // OWNER/ADMIN: sí si es el profesional; si no, apagado (puede encenderlo)
}

type Pref = Partial<Record<'emailAppointmentRequests' | 'emailPatientCancellations' | 'emailTaskSubmitted', boolean | null>> | null | undefined;

/** ¿Quiere este usuario este email? Elección expresa si la hay; si no, el defecto. */
export function wantsStaffEmail(pref: Pref, kind: StaffEmailKind, role: Role, isProfessional: boolean): boolean {
  if (!kindAllowedForRole(kind, role)) return false;
  const explicit = pref?.[KIND_FIELD[kind]];
  return typeof explicit === 'boolean' ? explicit : defaultFor(kind, role, isProfessional);
}

/** Vista de N4: valor efectivo, si es el defecto y si el rol puede cambiarlo. */
export function staffEmailPreferenceView(pref: Pref, role: Role) {
  return Object.fromEntries(
    STAFF_EMAIL_KINDS.map((kind) => {
      const explicit = pref?.[KIND_FIELD[kind]];
      const allowed = kindAllowedForRole(kind, role);
      return [kind, {
        enabled: allowed ? (typeof explicit === 'boolean' ? explicit : defaultFor(kind, role, true)) : false,
        isDefault: !allowed || typeof explicit !== 'boolean',
        available: allowed,
      }];
    }),
  ) as Record<StaffEmailKind, { enabled: boolean; isDefault: boolean; available: boolean }>;
}
