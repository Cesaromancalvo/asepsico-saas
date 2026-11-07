import { enqueueStaffEmails } from './email-outbox.store';
import { KIND_TEMPLATE, StaffEmailKind, wantsStaffEmail } from './staff-email-preferences';

type Db = any;

/**
 * N1/N2 · Encola el email «eco» de avisos de la campana YA creados (misma transacción). Solo para
 * miembros ACTIVOS del espacio que lo quieren según su preferencia o el defecto de su rol (§7).
 * Lee solo rol y preferencias: nada del paciente, de la cita ni del aviso salvo id y userId.
 *
 * `professionalIds`: el profesional de la cita/solicitud (o quien lo sustituye si está de baja).
 */
export async function enqueueStaffEmailsForNotices(
  tx: Db,
  params: { workspaceId: string; kind: StaffEmailKind; notices: { userId: string; dedupeKey: string }[]; professionalIds: Set<string> },
): Promise<number> {
  const { workspaceId, kind } = params;
  const userIds = [...new Set(params.notices.map((n) => n.userId).filter(Boolean))];
  if (!userIds.length) return 0;
  const recipients = await staffEmailRecipients(tx, workspaceId, kind, userIds, params.professionalIds);
  const keys = params.notices.filter((n) => recipients.has(n.userId)).map((n) => n.dedupeKey);
  if (!keys.length) return 0;
  const rows = await tx.notification.findMany({
    where: { workspaceId, audience: 'PROFESSIONAL', dedupeKey: { in: keys }, userId: { in: [...recipients] } },
    select: { id: true },
  });
  return enqueueStaffEmails(tx, workspaceId, rows.map((r: { id: string }) => ({ notificationId: r.id, template: KIND_TEMPLATE[kind] })));
}

/** De los usuarios dados, los que son miembros activos y quieren este tipo de email. */
export async function staffEmailRecipients(tx: Db, workspaceId: string, kind: StaffEmailKind, userIds: string[], professionalIds: Set<string>): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const [members, prefs] = await Promise.all([
    tx.workspaceMember.findMany({ where: { workspaceId, userId: { in: userIds }, status: 'ACTIVE' }, select: { userId: true, role: true } }),
    tx.notificationPreference.findMany({
      where: { workspaceId, userId: { in: userIds } },
      select: { userId: true, emailAppointmentRequests: true, emailPatientCancellations: true, emailTaskSubmitted: true },
    }),
  ]);
  const prefByUser = new Map<string, any>(prefs.map((p: any) => [p.userId, p]));
  return new Set(
    members
      .filter((m: { userId: string; role: string }) => wantsStaffEmail(prefByUser.get(m.userId), kind, m.role, professionalIds.has(m.userId)))
      .map((m: { userId: string }) => m.userId),
  );
}
