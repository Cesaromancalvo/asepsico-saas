import { routeToActiveMembers } from '../workspace-members/notification-recipients.util';
import { enqueueStaffEmailsForNotices } from './email/staff-email-enqueue';
import { StaffEmailKind } from './email/staff-email-preferences';
import { DEFAULT_TIME_ZONE, isValidTimeZone } from '../scheduling/time-zone.util';

/**
 * Avisos DENTRO de la app al personal cuando cambia una cita (decisión del Jefe 30/10). Se guardan
 * como SENT. Desde N1/N2 (07/11/2026) los cambios que hace el PACIENTE desde el portal (pedir cambio,
 * pedir cancelación, retirar una solicitud) encolan además un email «eco» (NotificationDelivery
 * EMAIL con plantilla fija, ver EMAIL_FOR_CHANGE) a quien lo quiera según sus preferencias. Los
 * cambios hechos por el equipo nunca generan email al equipo (N2-2). Sin SMS.
 *
 * Qué se guarda (criterio 26 de la reserva desde el portal, que sigue en pie):
 *  - title/body: texto GENÉRICO, sin nombre del paciente, fecha ni hora. Es lo único que podría
 *    viajar algún día por correo.
 *  - patientId (columna) y metadata.appointmentChange: tipo de cambio, ids de cita/solicitud, id del
 *    profesional e instantes ISO de antes y después. Nunca el nombre, ni notas, proceso, tipo de
 *    sesión o motivo de consulta.
 * El nombre del paciente y las fechas legibles se componen AL LEER (GET /notifications), con el
 * control de acceso de agenda del lector en ese momento: si el paciente ya no existe, o el lector
 * es un THERAPIST y la cita no es suya, se devuelve el texto genérico.
 *
 * REGLA PARA ENVÍOS EXTERNOS FUTUROS (correo, SMS, push; condición M1 de Argos): un envío fuera de la
 * app SOLO puede usar el title/body GUARDADOS (genéricos). NUNCA metadata, ni el texto enriquecido
 * de enrichAppointmentChanges, ni appointmentChange: eso es solo para la bandeja dentro de la app.
 * Lo bloquea el test «M1» de appointment-change-notices.security-spec.ts.
 *
 * Supresión: estos avisos llevan patientId y deben borrarse con el paciente (workspaceId +
 * patientId) cuando exista la purga del paciente; retención propuesta de 90 días (pendiente, ver
 * docs/STAFF_NOTIFICATIONS_API.md). Su existencia impide deshacer una importación de ese paciente.
 */

export const APPOINTMENT_CHANGES = [
  'RESCHEDULED_BY_STAFF',
  'CANCELLED_BY_STAFF',
  'PATIENT_REQUESTED_RESCHEDULE',
  'PATIENT_REQUESTED_CANCEL',
  'PATIENT_WITHDREW_REQUEST',
  'REQUEST_APPROVED',
  'REQUEST_REJECTED',
] as const;
export type AppointmentChange = (typeof APPOINTMENT_CHANGES)[number];
export type RequestType = 'NEW' | 'RESCHEDULE' | 'CANCEL';

type Slot = { startsAt: string; endsAt: string } | null;
export type AppointmentChangeMeta = {
  change: AppointmentChange;
  therapistId: string;
  sessionId: string | null;
  requestId: string | null;
  requestType: RequestType | null;
  from: Slot;
  to: Slot;
};

const GENERIC: Record<AppointmentChange, { type: 'SYSTEM' | 'APPOINTMENT_REQUEST' | 'APPOINTMENT_REQUEST_UPDATE'; title: string; body: string }> = {
  RESCHEDULED_BY_STAFF: { type: 'SYSTEM', title: 'Cita movida', body: 'Se ha movido una de tus citas. Consúltala en la agenda.' },
  CANCELLED_BY_STAFF: { type: 'SYSTEM', title: 'Cita cancelada', body: 'Se ha cancelado una de tus citas. Consúltala en la agenda.' },
  PATIENT_REQUESTED_RESCHEDULE: { type: 'APPOINTMENT_REQUEST', title: 'Solicitud de cambio de cita', body: 'Un paciente ha pedido cambiar una cita. Revísala en la agenda.' },
  PATIENT_REQUESTED_CANCEL: { type: 'APPOINTMENT_REQUEST', title: 'Solicitud de cancelación', body: 'Un paciente ha pedido cancelar una cita. Revísala en la agenda.' },
  PATIENT_WITHDREW_REQUEST: { type: 'APPOINTMENT_REQUEST_UPDATE', title: 'Solicitud retirada', body: 'Un paciente ha retirado su solicitud de cita.' },
  REQUEST_APPROVED: { type: 'APPOINTMENT_REQUEST_UPDATE', title: 'Solicitud de cita aprobada', body: 'Se ha aprobado una solicitud de cita. Consúltala en la agenda.' },
  REQUEST_REJECTED: { type: 'APPOINTMENT_REQUEST_UPDATE', title: 'Solicitud de cita rechazada', body: 'Se ha rechazado una solicitud de cita. Consúltala en la agenda.' },
};

/**
 * Cambios que generan email al equipo y con qué plantilla (N1/N2). Solo los que hace el paciente.
 * PATIENT_REQUESTED_RESCHEDULE es una solicitud que hay que atender → «Solicitudes de cita».
 */
export const EMAIL_FOR_CHANGE: Partial<Record<AppointmentChange, StaffEmailKind>> = {
  PATIENT_REQUESTED_RESCHEDULE: 'appointmentRequests',
  PATIENT_REQUESTED_CANCEL: 'patientCancellations',
  PATIENT_WITHDREW_REQUEST: 'patientCancellations',
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const slot = (startsAt: Date | null | undefined, endsAt: Date | null | undefined): Slot =>
  startsAt && endsAt ? { startsAt: iso(startsAt)!, endsAt: iso(endsAt)! } : null;

type Db = any;

/**
 * Crea el aviso para cada destinatario (en la transacción del llamante). Los ids de usuario se
 * enrutan con routeToActiveMembers (profesional dado de baja → OWNER/ADMIN activos), se quitan
 * duplicados y NUNCA se avisa a quien hizo el cambio.
 */
export async function notifyStaffOfAppointmentChange(
  tx: Db,
  params: {
    workspaceId: string;
    patientId: string;
    actorId: string | null;
    meta: AppointmentChangeMeta;
    recipients: string[];
    dedupeBase: string;
  },
) {
  const { workspaceId, patientId, actorId, meta } = params;
  // Quien hace el cambio nunca se avisa a sí mismo (ni se consulta su membresía para ello).
  const wanted = params.recipients.filter((id) => id && id !== actorId);
  if (!wanted.length) return 0;
  const routes = await routeToActiveMembers(tx, workspaceId, wanted);
  const userIds = [...new Set([...routes.values()].flat())].filter((id) => id && id !== actorId);
  if (!userIds.length) return 0;
  const generic = GENERIC[meta.change];
  const now = new Date();
  const dedupeKey = (userId: string) => `${params.dedupeBase}:to:${userId}`;
  await tx.notification.createMany({
    data: userIds.map((userId) => ({
      workspaceId, audience: 'PROFESSIONAL', userId, patientId, type: generic.type,
      title: generic.title, body: generic.body, actionUrl: meta.requestId && meta.change.startsWith('PATIENT_REQUESTED') ? '/agenda/solicitudes' : '/agenda',
      status: 'SENT', scheduledAt: now, sentAt: now,
      dedupeKey: dedupeKey(userId),
      metadata: { appointmentChange: meta },
    })),
    skipDuplicates: true,
  });
  // Email «eco» solo si el cambio lo hizo el paciente (actorId nulo) y el tipo lo prevé.
  const kind = EMAIL_FOR_CHANGE[meta.change];
  if (kind && actorId === null) {
    // El profesional de la cita, o quien lo sustituye si está de baja (routeToActiveMembers).
    const professionalIds = new Set(routes.get(meta.therapistId) ?? [meta.therapistId]);
    await enqueueStaffEmailsForNotices(tx, { workspaceId, kind, professionalIds, notices: userIds.map((userId) => ({ userId, dedupeKey: dedupeKey(userId) })) });
  }
  return userIds.length;
}

/** OWNER, ADMIN y recepción (ASSISTANT) activos del espacio: gestionan la agenda de todos. */
export async function agendaManagers(tx: Db, workspaceId: string): Promise<string[]> {
  const rows = await tx.workspaceMember.findMany({
    where: { workspaceId, role: { in: ['OWNER', 'ADMIN', 'ASSISTANT'] }, status: 'ACTIVE' },
    select: { userId: true },
  });
  return rows.map((r: { userId: string }) => r.userId);
}

// ------------------------------------------------------------------------------------------------
// Lectura

export function readAppointmentChange(metadata: unknown): AppointmentChangeMeta | null {
  const raw = (metadata as any)?.appointmentChange;
  if (!raw || typeof raw !== 'object' || !APPOINTMENT_CHANGES.includes(raw.change)) return null;
  return raw as AppointmentChangeMeta;
}

function label(value: string | null | undefined, timeZone: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('es-ES', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

/** Texto con nombre y fechas. Solo se llama si el lector puede ver la cita. */
export function renderAppointmentChange(meta: AppointmentChangeMeta, patientName: string, ownAppointment: boolean, timeZone: string): string {
  const from = label(meta.from?.startsAt, timeZone) ?? 'la hora anterior';
  const to = label(meta.to?.startsAt, timeZone) ?? 'la nueva hora';
  const cita = ownAppointment ? 'tu cita' : 'la cita';
  const what = meta.requestType === 'CANCEL' ? 'cancelar' : meta.requestType === 'NEW' ? 'pedir' : 'cambiar';
  switch (meta.change) {
    case 'RESCHEDULED_BY_STAFF':
      return `Se ha movido ${cita} con ${patientName}: de ${from} a ${to}.`;
    case 'CANCELLED_BY_STAFF':
      return `Se ha cancelado ${cita} con ${patientName} del ${from}.`;
    case 'PATIENT_REQUESTED_RESCHEDULE':
      return `${patientName} ha pedido cambiar la cita del ${from} al ${to}.`;
    case 'PATIENT_REQUESTED_CANCEL':
      return `${patientName} ha pedido cancelar la cita del ${from}.`;
    case 'PATIENT_WITHDREW_REQUEST':
      return `${patientName} ha retirado su solicitud de ${what} la cita del ${from}.`;
    case 'REQUEST_APPROVED':
      if (meta.requestType === 'NEW') return `Se ha aprobado la cita que pidió ${patientName} para el ${to}.`;
      if (meta.requestType === 'CANCEL') return `Se ha aprobado la cancelación que pidió ${patientName}: la cita del ${from} queda cancelada.`;
      return `Se ha aprobado el cambio que pidió ${patientName}: la cita del ${from} pasa al ${to}.`;
    case 'REQUEST_REJECTED':
      if (meta.requestType === 'NEW') return `Se ha rechazado la cita que pidió ${patientName} para el ${to}.`;
      return `Se ha rechazado la solicitud de ${patientName} de ${what} la cita del ${from}.`;
  }
}

/**
 * SOLO para GET /notifications (bandeja dentro de la app). Nunca para correo ni otro envío externo:
 * ese envío usaría el title/body guardados (ver la regla M1 al principio del archivo).
 *
 * Añade a cada aviso de cambio de cita `appointmentChange` (estructurado) y su `body` con nombre y
 * fechas, si el lector puede verlo:
 *  - OWNER / ADMIN / ASSISTANT: agenda de todo el espacio (solo datos de agenda).
 *  - THERAPIST: solo si la cita es suya (metadata.therapistId === lector).
 * Paciente buscado por id Y workspaceId, sin borrar. Si no, texto genérico y patient = null.
 */
const PUBLIC_FIELDS = ['id', 'type', 'title', 'body', 'actionUrl', 'status', 'scheduledAt', 'sentAt', 'readAt', 'createdAt'] as const;

export async function enrichAppointmentChanges(prisma: Db, actor: { sub: string; workspaceId: string; role: string }, rows: any[]) {
  const parsed = rows.map((row) => ({ row, meta: readAppointmentChange(row.metadata) }));
  const canSee = (meta: AppointmentChangeMeta) => actor.role !== 'THERAPIST' || meta.therapistId === actor.sub;
  const patientIds = [...new Set(parsed.filter((p) => p.meta && canSee(p.meta) && p.row.patientId).map((p) => p.row.patientId as string))];
  const [patients, workspace] = await Promise.all([
    patientIds.length
      ? prisma.patient.findMany({ where: { id: { in: patientIds }, workspaceId: actor.workspaceId, deletedAt: null }, select: { id: true, firstName: true, lastName: true } })
      : Promise.resolve([]),
    parsed.some((p) => p.meta) ? prisma.workspace.findFirst({ where: { id: actor.workspaceId }, select: { timeZone: true } }) : Promise.resolve(null),
  ]);
  const timeZone = isValidTimeZone(workspace?.timeZone) ? workspace.timeZone : DEFAULT_TIME_ZONE;
  const byId = new Map<string, any>(patients.map((p: any) => [p.id, p]));

  return parsed.map(({ row, meta }) => {
    // Lista blanca de campos (no se confía solo en el select): nunca metadata, patientId, userId ni dedupeKey.
    const { patientId } = row;
    const rest = Object.fromEntries(PUBLIC_FIELDS.map((key) => [key, row[key]]));
    if (!meta) return { ...rest, appointmentChange: null };
    const patient = canSee(meta) ? byId.get(patientId) : undefined;
    const structured = {
      change: meta.change,
      requestType: meta.requestType,
      sessionId: meta.sessionId,
      requestId: meta.requestId,
      from: meta.from,
      to: meta.to,
      patient: patient ? { id: patient.id, firstName: patient.firstName, lastName: patient.lastName } : null,
    };
    if (!patient) return { ...rest, appointmentChange: { ...structured, from: null, to: null, sessionId: null, requestId: null } };
    const name = `${patient.firstName} ${patient.lastName}`.trim();
    return { ...rest, body: renderAppointmentChange(meta, name, meta.therapistId === actor.sub, timeZone), appointmentChange: structured };
  });
}
