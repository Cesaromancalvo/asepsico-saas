/**
 * Bandeja de avisos del personal (campana de la app). Solo dentro de la app: nunca correo ni SMS.
 *
 *   GET   /api/v1/notifications?unreadOnly=true   → StaffNotification[] (máx. 100, más recientes primero)
 *   GET   /api/v1/notifications/unread-count      → StaffNotificationsUnreadCount
 *   PATCH /api/v1/notifications/:id/read          → { ok: true }  (404 si no es tuyo o de otro espacio)
 *   POST  /api/v1/notifications/read-all          → StaffNotificationsReadAll
 *
 * Cualquier miembro del espacio (OWNER, ADMIN, THERAPIST, ASSISTANT) ve SOLO sus avisos y solo los
 * de su espacio. Las escrituras llevan cabecera CSRF, como el resto de la app.
 */

/** Tipo de cambio de cita. Fechas en ISO 8601 (instantes); la web las pinta en la zona del espacio. */
export type AppointmentChangeKind =
  /** Recepción, OWNER o ADMIN han movido una cita del profesional. */
  | 'RESCHEDULED_BY_STAFF'
  /** Recepción, OWNER o ADMIN han cancelado una cita del profesional. */
  | 'CANCELLED_BY_STAFF'
  /** El paciente pide desde el portal cambiar una cita (to = hora pedida). */
  | 'PATIENT_REQUESTED_RESCHEDULE'
  /** El paciente pide desde el portal cancelar una cita. */
  | 'PATIENT_REQUESTED_CANCEL'
  /** El paciente retira su petición de cambio o cancelación. */
  | 'PATIENT_WITHDREW_REQUEST'
  /** Otra persona ha aprobado una solicitud del portal de este profesional. */
  | 'REQUEST_APPROVED'
  /** Otra persona ha rechazado una solicitud del portal de este profesional. */
  | 'REQUEST_REJECTED';

export interface AppointmentChangeSlot { startsAt: string; endsAt: string; }

export interface StaffAppointmentChange {
  change: AppointmentChangeKind;
  /** Tipo de la solicitud del portal, si la hay. */
  requestType: 'NEW' | 'RESCHEDULE' | 'CANCEL' | null;
  /**
   * null cuando el lector no puede ver esa cita (THERAPIST y la cita no es suya) o el paciente ya
   * no existe: entonces from/to/sessionId/requestId también son null y `body` es el texto genérico.
   */
  patient: { id: string; firstName: string; lastName: string } | null;
  sessionId: string | null;
  requestId: string | null;
  /** Hora de la cita antes del cambio (null en una cita nueva). */
  from: AppointmentChangeSlot | null;
  /** Hora nueva o pedida (null en una cancelación). */
  to: AppointmentChangeSlot | null;
}

export interface StaffNotification {
  id: string;
  /** SYSTEM, APPOINTMENT_REQUEST, APPOINTMENT_REQUEST_UPDATE, APPOINTMENT_REMINDER, TASK_DUE, CLINICAL_ACCESS_NOTICE… */
  type: string;
  title: string;
  /** Texto listo para mostrar. En los cambios de cita incluye nombre del paciente y fechas. */
  body: string;
  actionUrl: string | null;
  status: 'PENDING' | 'SENT' | 'READ' | 'CANCELLED' | 'FAILED';
  scheduledAt: string;
  sentAt: string | null;
  readAt: string | null;
  createdAt: string;
  /** Solo en avisos de cambio de cita; null en el resto. */
  appointmentChange: StaffAppointmentChange | null;
}

export interface StaffNotificationsUnreadCount { unread: number; }
export interface StaffNotificationsReadAll { ok: true; updated: number; }
