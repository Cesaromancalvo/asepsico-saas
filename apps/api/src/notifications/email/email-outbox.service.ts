import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { DEFAULT_TIME_ZONE, isValidTimeZone, localToUtc, zonedParts } from '../../scheduling/time-zone.util';
import { renderStaffEmail, StaffTemplate, templatesOf } from './email-templates';
import { ClaimedDelivery, claimDue, defer, expireDue, lastStaffEmailAt, markCancelled, markFailed, markSent, workspacesWithDueEmail } from './email-outbox.store';
import { EmailGroup, groupEnabledFor } from './notification-email.config';
import { NotificationMailer } from './notification-mailer';
// Grupo PATIENT: el destinatario solo puede salir de patientRecipientEmail (Argos M2). En N0 aún no
// hay plantillas de paciente y sus entregas se cancelan (TEMPLATE_UNAVAILABLE) sin leer ningún correo.
export { patientRecipientEmail } from './patient-recipient';
import { isDeliverableStaffUser, RECIPIENT_NOT_DELIVERABLE } from './recipient-deliverability';
import { kindAllowedForRole, KIND_FIELD, TEMPLATE_KIND } from './staff-email-preferences';

export const STAFF_MIN_INTERVAL_MS = 30 * 60_000;
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;
/** Espacio de claves (primer int4) de los advisory locks de la bandeja: no choca con los de la agenda. */
export const EMAIL_OUTBOX_LOCK_SPACE = 7302;
/** Límite de una pasada de un espacio (la reserva de entregas dura 30 min). */
const PASS_TIMEOUT_MS = 15 * 60_000;

export type PassCounts = {
  skippedLocked?: boolean;
  emailsSent: number;
  deliveriesSent: number;
  grouped: number;
  expired: number;
  failed: number;
  retried: number;
  deferred: Record<string, number>;
  cancelled: Record<string, number>;
};

const emptyCounts = (): PassCounts => ({ emailsSent: 0, deliveriesSent: 0, grouped: 0, expired: 0, failed: 0, retried: 0, deferred: {}, cancelled: {} });
const bump = (bag: Record<string, number>, key: string, n: number) => { if (n) bag[key] = (bag[key] ?? 0) + n; };
const hasActivity = (c: PassCounts) =>
  c.emailsSent + c.expired + c.failed + c.retried + Object.values(c.deferred).reduce((a, b) => a + b, 0) + Object.values(c.cancelled).reduce((a, b) => a + b, 0) > 0;

/** Siguiente fin de la franja silenciosa (08:00 local) si `now` cae dentro de 21:00–08:00; si no, null. */
export function quietHoursEnd(now: Date, timeZone: string): Date | null {
  const p = zonedParts(now, timeZone);
  if (p.hour >= QUIET_END_HOUR && p.hour < QUIET_START_HOUR) return null;
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + (p.hour >= QUIET_START_HOUR ? 1 : 0)));
  return localToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), QUIET_END_HOUR * 60, timeZone)
    ?? new Date(now.getTime() + 60 * 60_000);
}

/**
 * Bandeja de salida de los avisos por email (N0). La llama la tarea programada cada 5 minutos
 * (EmailOutboxScheduler); no hay endpoint para lanzarla.
 *
 * Por cada espacio con entregas vencidas: caduca las viejas, y por cada grupo (STAFF, PATIENT)
 * SOLO si su interruptor, su configuración y su lista blanca lo permiten, reserva, envía y cierra.
 * Con un grupo apagado no se lee ni se reserva nada de ese grupo. Un AuditLog por espacio y pasada
 * con recuentos, sin datos personales. Los logs solo llevan id de entrega y código.
 */
@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger('EmailOutbox');
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly mailer: NotificationMailer) {}

  private db(): any {
    return this.prisma as any;
  }

  async processPass(now = new Date()): Promise<Record<string, PassCounts>> {
    if (this.running) return {};
    this.running = true;
    try {
      const result: Record<string, PassCounts> = {};
      for (const workspaceId of await workspacesWithDueEmail(this.db(), now)) {
        try {
          result[workspaceId] = await this.processWorkspace(workspaceId, now);
        } catch (error) {
          this.logger.error(`Pasada fallida en un espacio: ${(error as Error)?.name ?? 'Error'}`);
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Una pasada en un espacio. Argos B1: la pasada de un espacio se serializa entre instancias con
   * pg_try_advisory_xact_lock (espacio de claves propio de la bandeja); si otra instancia está con
   * ese espacio, esta lo salta. El bloqueo vive en una transacción abierta durante la pasada; las
   * escrituras van fuera de ella y se confirman al momento (un SENT nunca se deshace).
   */
  async processWorkspace(workspaceId: string, now = new Date()): Promise<PassCounts> {
    return this.db().$transaction(
      async (tx: any) => {
        const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${EMAIL_OUTBOX_LOCK_SPACE}::int4, hashtext(${workspaceId})) AS "locked"`;
        if (!rows?.[0]?.locked) return { ...emptyCounts(), skippedLocked: true } as PassCounts;
        return this.processWorkspaceLocked(workspaceId, now);
      },
      { maxWait: 10_000, timeout: PASS_TIMEOUT_MS },
    );
  }

  private async processWorkspaceLocked(workspaceId: string, now: Date): Promise<PassCounts> {
    const counts = emptyCounts();
    try {
      counts.expired = await expireDue(this.db(), workspaceId, now);
      for (const group of ['STAFF', 'PATIENT'] as EmailGroup[]) {
        if (!groupEnabledFor(this.mailer.config, group, workspaceId)) continue;
        const token = randomUUID();
        const claimed = await claimDue(this.db(), workspaceId, templatesOf(group), now, token);
        if (!claimed.length) continue;
        if (group === 'STAFF') await this.sendStaff(workspaceId, claimed, token, now, counts);
        else bump(counts.cancelled, 'TEMPLATE_UNAVAILABLE', await markCancelled(this.db(), workspaceId, claimed.map((c) => c.id), token, 'TEMPLATE_UNAVAILABLE'));
      }
    } finally {
      // Argos B3: el recuento se audita aunque la pasada falle a medias (lo ya enviado consta).
      counts.grouped = counts.deliveriesSent - counts.emailsSent;
      if (hasActivity(counts)) {
        await this.db().auditLog.create({
          data: { workspaceId, actorId: null, action: 'EMAIL_OUTBOX_PASS', entityType: 'NotificationDelivery', metadata: counts },
        });
      }
    }
    return counts;
  }

  private async sendStaff(workspaceId: string, claimed: ClaimedDelivery[], token: string, now: Date, counts: PassCounts) {
    const db = this.db();
    const cancel = async (rows: ClaimedDelivery[], code: string) => bump(counts.cancelled, code, await markCancelled(db, workspaceId, rows.map((r) => r.id), token, code));

    const invalid = claimed.filter((d) => d.notification.workspaceId !== workspaceId || d.notification.audience !== 'PROFESSIONAL' || !d.notification.userId);
    await cancel(invalid, 'INVALID_RECIPIENT');
    const valid = claimed.filter((d) => !invalid.includes(d));
    const read = valid.filter((d) => d.notification.readAt || d.notification.status === 'READ');
    await cancel(read, 'ALREADY_READ');
    const pending = valid.filter((d) => !read.includes(d));
    if (!pending.length) return;

    const workspace = await db.workspace.findFirst({ where: { id: workspaceId }, select: { name: true, timeZone: true } });
    const timeZone = isValidTimeZone(workspace?.timeZone) ? workspace.timeZone : DEFAULT_TIME_ZONE;
    const quietEnd = quietHoursEnd(now, timeZone);

    const byUser = new Map<string, ClaimedDelivery[]>();
    for (const d of pending) byUser.set(d.notification.userId as string, [...(byUser.get(d.notification.userId as string) ?? []), d]);

    for (const [userId, rows] of byUser) {
      const member = await db.workspaceMember.findFirst({
        where: { workspaceId, userId, status: 'ACTIVE' },
        select: { role: true, user: { select: { email: true, isDemo: true } } },
      });
      if (!member?.user?.email) { await cancel(rows, 'RECIPIENT_INACTIVE'); continue; }
      // Dora R1: segunda comprobación al enviar (el usuario pudo pasar a demo o cambiar de correo).
      if (!isDeliverableStaffUser(member.user)) { await cancel(rows, RECIPIENT_NOT_DELIVERABLE); continue; }

      const pref = await db.notificationPreference.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { emailAppointmentRequests: true, emailPatientCancellations: true, emailTaskSubmitted: true },
      });
      const notAllowed = rows.filter((r) => !kindAllowedForRole(TEMPLATE_KIND[r.template as StaffTemplate], member.role));
      await cancel(notAllowed, 'ROLE_NOT_ALLOWED');
      const turnedOff = rows.filter((r) => !notAllowed.includes(r) && pref?.[KIND_FIELD[TEMPLATE_KIND[r.template as StaffTemplate]]] === false);
      await cancel(turnedOff, 'PREFERENCE_OFF');
      const toSend = rows.filter((r) => !notAllowed.includes(r) && !turnedOff.includes(r));
      if (!toSend.length) continue;

      if (quietEnd) { bump(counts.deferred, 'QUIET_HOURS', await defer(db, workspaceId, toSend.map((r) => r.id), token, quietEnd)); continue; }
      const last = await lastStaffEmailAt(db, workspaceId, userId, new Date(now.getTime() - STAFF_MIN_INTERVAL_MS));
      if (last) { bump(counts.deferred, 'GROUPING', await defer(db, workspaceId, toSend.map((r) => r.id), token, new Date(last.getTime() + STAFF_MIN_INTERVAL_MS))); continue; }

      const email = renderStaffEmail(toSend.map((r) => r.template as StaffTemplate), workspace?.name ?? '', this.mailer.config.appUrl);
      try {
        const { providerRef } = await this.mailer.send(toSend[0].template, member.user.email, email);
        const sent = await markSent(db, workspaceId, toSend.map((r) => r.id), token, providerRef, now);
        counts.deliveriesSent += sent;
        counts.emailsSent += 1;
      } catch (error) {
        const code = (error as Error)?.message === 'INVALID_RECIPIENT' ? 'INVALID_RECIPIENT' : 'PROVIDER_ERROR';
        for (const r of toSend) this.logger.warn(`Entrega ${r.id} no enviada: ${code}`);
        if (code === 'INVALID_RECIPIENT') { await cancel(toSend, code); continue; }
        const { failed, retried } = await markFailed(db, workspaceId, toSend, token, now, code);
        counts.failed += failed;
        counts.retried += retried;
      }
    }
  }
}
