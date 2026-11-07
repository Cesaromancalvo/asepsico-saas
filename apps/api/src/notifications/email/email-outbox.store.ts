import { Prisma } from '@prisma/client';
import { EmailTemplateName, STAFF_TEMPLATES, StaffTemplate } from './email-templates';

/**
 * Acceso a la bandeja de salida (NotificationDelivery canal EMAIL). TODA lectura y escritura lleva
 * workspaceId. Las escrituras de cierre llevan además el claimToken de la pasada (compare-and-set):
 * una pasada nunca toca entregas que no reservó.
 *
 * Ninguna consulta de aquí carga clinicalProcess, notas, tareas ni facturas, ni el title/body o la
 * metadata de la Notification (N0-10).
 */

type Db = any;

export const STAFF_EMAIL_TTL_MS = 12 * 3_600_000;
export const CLAIM_LEASE_MS = 30 * 60_000;
export const MAX_ATTEMPTS = 3;
/** Espera antes del 2.º y 3.er intento: todos dentro de la hora siguiente al primero. */
export const RETRY_DELAYS_MS = [10 * 60_000, 20 * 60_000];
const CLAIM_BATCH = 200;

/** Datos mínimos de una entrega reservada. */
export type ClaimedDelivery = {
  id: string;
  template: EmailTemplateName;
  attempts: number;
  notification: { id: string; workspaceId: string; audience: string; userId: string | null; patientId: string | null; status: string; readAt: Date | null };
};

/**
 * Encola emails de staff para avisos YA creados (en la transacción del llamante). Comprueba que cada
 * Notification es del espacio, del público PROFESSIONAL y de un usuario. Idempotente: una entrega
 * EMAIL por notificación (único notificationId + channel).
 */
export async function enqueueStaffEmails(
  tx: Db,
  workspaceId: string,
  items: { notificationId: string; template: StaffTemplate }[],
  now = new Date(),
): Promise<number> {
  if (!items.length) return 0;
  if (items.some((i) => !(STAFF_TEMPLATES as readonly string[]).includes(i.template))) throw new Error('Plantilla de staff no válida');
  const valid = await tx.notification.findMany({
    where: { id: { in: items.map((i) => i.notificationId) }, workspaceId, audience: 'PROFESSIONAL', userId: { not: null } },
    select: { id: true },
  });
  const ok = new Set(valid.map((v: { id: string }) => v.id));
  const data = items.filter((i) => ok.has(i.notificationId)).map((i) => ({
    workspaceId, notificationId: i.notificationId, channel: 'EMAIL' as const, status: 'PENDING' as const, template: i.template,
    scheduledAt: now, expiresAt: new Date(now.getTime() + STAFF_EMAIL_TTL_MS),
  }));
  if (!data.length) return 0;
  const result = await tx.notificationDelivery.createMany({ data, skipDuplicates: true });
  return result.count;
}

/** Espacios con entregas EMAIL pendientes que vencen o caducan ya (índice del planificador). */
export async function workspacesWithDueEmail(db: Db, now: Date): Promise<string[]> {
  const rows = await db.notificationDelivery.findMany({
    where: { channel: 'EMAIL', status: 'PENDING', template: { not: null }, OR: [{ scheduledAt: { lte: now } }, { expiresAt: { lte: now } }] },
    distinct: ['workspaceId'],
    select: { workspaceId: true },
    take: 500,
  });
  return rows.map((r: { workspaceId: string }) => r.workspaceId);
}

/** Caducadas → CANCELLED / EXPIRED (aunque su grupo esté apagado: nunca sale un aviso viejo). */
export async function expireDue(db: Db, workspaceId: string, now: Date): Promise<number> {
  const { count } = await db.notificationDelivery.updateMany({
    where: { workspaceId, channel: 'EMAIL', status: 'PENDING', template: { not: null }, expiresAt: { lte: now }, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] },
    data: { status: 'CANCELLED', errorCode: 'EXPIRED', claimToken: null, claimedUntil: null },
  });
  return count;
}

/**
 * Reserva atómica (FOR UPDATE SKIP LOCKED + plazo de reserva): dos pasadas simultáneas nunca
 * reservan la misma entrega (N0-2). Devuelve las entregas reservadas con su aviso.
 */
export async function claimDue(db: Db, workspaceId: string, templates: readonly EmailTemplateName[], now: Date, token: string): Promise<ClaimedDelivery[]> {
  if (!templates.length) return [];
  const until = new Date(now.getTime() + CLAIM_LEASE_MS);
  await db.$executeRaw(Prisma.sql`
    UPDATE "NotificationDelivery" SET "claimToken" = ${token}, "claimedUntil" = ${until}
    WHERE "id" IN (
      SELECT "id" FROM "NotificationDelivery"
      WHERE "workspaceId" = ${workspaceId} AND "channel" = 'EMAIL' AND "status" = 'PENDING'
        AND "template"::text = ANY(${[...templates]}::text[])
        AND "scheduledAt" <= ${now} AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
        AND ("claimedUntil" IS NULL OR "claimedUntil" < ${now})
      ORDER BY "scheduledAt" ASC
      LIMIT ${CLAIM_BATCH}
      FOR UPDATE SKIP LOCKED
    )`);
  return db.notificationDelivery.findMany({
    where: { workspaceId, claimToken: token, status: 'PENDING' },
    orderBy: { scheduledAt: 'asc' },
    select: {
      id: true, template: true, attempts: true,
      notification: { select: { id: true, workspaceId: true, audience: true, userId: true, patientId: true, status: true, readAt: true } },
    },
  });
}

const mine = (workspaceId: string, ids: string[], token: string) => ({ id: { in: ids }, workspaceId, claimToken: token, status: 'PENDING' as const });

export async function markSent(db: Db, workspaceId: string, ids: string[], token: string, providerRef: string | null, now: Date) {
  if (!ids.length) return 0;
  const { count } = await db.notificationDelivery.updateMany({
    where: mine(workspaceId, ids, token),
    data: { status: 'SENT', providerRef, attemptedAt: now, sentAt: now, attempts: { increment: 1 }, errorCode: null, claimToken: null, claimedUntil: null },
  });
  return count;
}

export async function markCancelled(db: Db, workspaceId: string, ids: string[], token: string, code: string) {
  if (!ids.length) return 0;
  const { count } = await db.notificationDelivery.updateMany({
    where: mine(workspaceId, ids, token),
    data: { status: 'CANCELLED', errorCode: code, claimToken: null, claimedUntil: null },
  });
  return count;
}

/** Devuelve las entregas a la cola para más tarde (franja silenciosa o agrupación), sin gastar intento. */
export async function defer(db: Db, workspaceId: string, ids: string[], token: string, until: Date) {
  if (!ids.length) return 0;
  const { count } = await db.notificationDelivery.updateMany({
    where: mine(workspaceId, ids, token),
    data: { scheduledAt: until, claimToken: null, claimedUntil: null },
  });
  return count;
}

/** Fallo del proveedor: reintento (10 y 20 min) o FAILED con código genérico al 3.er fallo. */
export async function markFailed(db: Db, workspaceId: string, rows: { id: string; attempts: number }[], token: string, now: Date, code = 'PROVIDER_ERROR') {
  let failed = 0;
  let retried = 0;
  for (const row of rows) {
    const attempts = row.attempts + 1;
    const final = attempts >= MAX_ATTEMPTS;
    const { count } = await db.notificationDelivery.updateMany({
      where: mine(workspaceId, [row.id], token),
      data: final
        ? { status: 'FAILED', attempts, attemptedAt: now, errorCode: code, claimToken: null, claimedUntil: null }
        : { attempts, attemptedAt: now, errorCode: code, scheduledAt: new Date(now.getTime() + RETRY_DELAYS_MS[attempts - 1]), claimToken: null, claimedUntil: null },
    });
    if (count) final ? failed++ : retried++;
  }
  return { failed, retried };
}

/** Último email de staff ENVIADO a este usuario en este espacio (agrupación de 30 min). */
export async function lastStaffEmailAt(db: Db, workspaceId: string, userId: string, since: Date): Promise<Date | null> {
  const last = await db.notificationDelivery.findFirst({
    where: { workspaceId, channel: 'EMAIL', status: 'SENT', template: { in: [...STAFF_TEMPLATES] }, sentAt: { gt: since }, notification: { workspaceId, userId } },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true },
  });
  return last?.sentAt ?? null;
}
