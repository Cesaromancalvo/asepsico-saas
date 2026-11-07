import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { EmailOutboxService } from '../src/notifications/email/email-outbox.service';
import { enqueueStaffEmails } from '../src/notifications/email/email-outbox.store';
import { NotificationMailer } from '../src/notifications/email/notification-mailer';

/**
 * N0 · Bandeja de salida de avisos por email contra PostgreSQL REAL: reserva con SKIP LOCKED,
 * concurrencia, reintentos, caducidad, agrupación, franja silenciosa, aislamiento por espacio y
 * auditoría. El transporte SMTP es FALSO (no sale nada a la red).
 *
 * Como los demás *-db: solo con RACE_DATABASE_URL (BD DESECHABLE ya migrada); con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Datos 100 % ficticios. Las pasadas se
 * lanzan por espacio (processWorkspace) para no tocar datos de otros tests en la misma BD.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de la bandeja de email no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

const MIN = 60_000;
// Martes 15/01/2030 11:00 en Madrid (10:00 UTC): fuera de la franja silenciosa.
const T0 = new Date('2030-01-15T10:00:00.000Z');
const ENV = {
  MAIL_SMTP_HOST: 'smtp.example.test', MAIL_SMTP_PORT: '2465', MAIL_SMTP_USER: 'usuario-ficticio', MAIL_SMTP_PASSWORD: 'secreto-ficticio',
  MAIL_FROM: 'AsePsico <avisos@notificaciones.example.test>', STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'true',
};

describeDb('Bandeja de salida de avisos por email (PostgreSQL real)', () => {
  let prisma: PrismaClient;
  const run = `outbox-${Date.now()}`;
  let seq = 0;

  beforeAll(() => { prisma = new PrismaClient({ datasourceUrl: url }); });
  afterAll(async () => { await prisma?.$disconnect(); });

  function outbox(env: Record<string, string> = ENV, send = jest.fn(async () => ({ messageId: `<ref-${++seq}@example.test>` }))) {
    const mailer = new NotificationMailer(env as any, () => ({ send }));
    return { service: new EmailOutboxService(prisma as any, mailer), send };
  }

  async function scenario(name = 'Consulta ficticia') {
    const ws = await prisma.workspace.create({ data: { name: `${name} ${run}-${++seq}`, timeZone: 'Europe/Madrid' } });
    const users: Record<string, string> = {};
    const add = async (key: string, role: string, extra: Record<string, unknown> = {}) => {
      const u = await prisma.user.create({ data: { email: `${key}-${run}-${seq}-${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: 'hash-ficticio', firstName: key, lastName: 'Ficticio' } });
      await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role: role as any, isClinician: role === 'THERAPIST', ...extra } as any });
      users[key] = u.id;
    };
    await add('therapist', 'THERAPIST');
    await add('assistant', 'ASSISTANT');
    await add('removed', 'THERAPIST', { status: 'REMOVED', removedAt: new Date() });
    return { ws, users };
  }

  /** Aviso en la campana + entrega EMAIL encolada, como hará N1. */
  async function notice(workspaceId: string, userId: string, template: any = 'STAFF_APPOINTMENT_REQUEST', at = T0) {
    const n = await prisma.notification.create({
      data: { workspaceId, audience: 'PROFESSIONAL', userId, type: 'APPOINTMENT_REQUEST', title: 'Nueva solicitud de cita', body: 'Texto genérico', status: 'SENT', scheduledAt: at, sentAt: at, dedupeKey: `${run}-${++seq}` },
    });
    await prisma.$transaction((tx) => enqueueStaffEmails(tx, workspaceId, [{ notificationId: n.id, template }], at));
    return prisma.notificationDelivery.findFirstOrThrow({ where: { workspaceId, notificationId: n.id, channel: 'EMAIL' } });
  }

  const delivery = (id: string) => prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

  it('N0-1 · con el interruptor en true sale por el transporte y queda SENT con providerRef y attemptedAt', async () => {
    const { ws, users } = await scenario();
    const d = await notice(ws.id, users.therapist);
    const { service, send } = outbox();
    await service.processWorkspace(ws.id, T0);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = (send.mock.calls[0] as any)[0];
    expect(msg.from).toBe(ENV.MAIL_FROM);
    expect(msg.text).toContain(ws.name);
    const after = await delivery(d.id);
    expect(after).toEqual(expect.objectContaining({ status: 'SENT', attempts: 1, claimToken: null }));
    expect(after.providerRef).toMatch(/^<ref-/);
    expect(after.attemptedAt?.toISOString()).toBe(T0.toISOString());
  });

  it('N0-4 · con el interruptor apagado no sale nada y la entrega sigue PENDING', async () => {
    const { ws, users } = await scenario();
    const d = await notice(ws.id, users.therapist);
    const { service, send } = outbox({ ...ENV, STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'false' });
    await service.processWorkspace(ws.id, T0);
    expect(send).not.toHaveBeenCalled();
    expect((await delivery(d.id)).status).toBe('PENDING');
  });

  it('N0-2 · dos pasadas simultáneas: cada entrega sale una sola vez', async () => {
    const { ws, users } = await scenario();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await notice(ws.id, i % 2 ? users.therapist : users.assistant)).id);
    const a = outbox();
    const b = outbox();
    await Promise.all([a.service.processWorkspace(ws.id, T0), b.service.processWorkspace(ws.id, T0), a.service.processWorkspace(ws.id, T0)]);
    const sentTo = [...a.send.mock.calls, ...b.send.mock.calls].map((c: any) => c[0].to);
    // Un email por usuario como mucho (agrupado) y todas las entregas SENT una vez.
    expect(new Set(sentTo).size).toBe(sentTo.length);
    const rows = await prisma.notificationDelivery.findMany({ where: { workspaceId: ws.id, id: { in: ids } } });
    expect(rows.every((r) => r.status === 'SENT' && r.attempts === 1)).toBe(true);
  });

  it('B1 · con otra instancia procesando el espacio (advisory lock tomado), esta pasada lo salta', async () => {
    const { ws, users } = await scenario();
    const d = await notice(ws.id, users.therapist);
    const { service, send } = outbox();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7302::int4, hashtext(${ws.id}))`;
      locked();
      await held;
    }, { timeout: 30_000 });
    await isLocked;
    const counts = await service.processWorkspace(ws.id, T0);
    release();
    await holder;
    expect(counts.skippedLocked).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect((await delivery(d.id)).status).toBe('PENDING');
    await service.processWorkspace(ws.id, T0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('agrupación: varias entregas del mismo usuario → un email; lo siguiente espera 30 min desde el último', async () => {
    const { ws, users } = await scenario();
    const first = [await notice(ws.id, users.therapist), await notice(ws.id, users.therapist), await notice(ws.id, users.therapist, 'STAFF_PATIENT_CANCELLATION')];
    const { service, send } = outbox();
    await service.processWorkspace(ws.id, T0);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as any)[0].text).toContain('2 solicitudes de cita nuevas, 1 cancelación');
    const refs = new Set((await prisma.notificationDelivery.findMany({ where: { workspaceId: ws.id, id: { in: first.map((f) => f.id) } } })).map((r) => r.providerRef));
    expect(refs.size).toBe(1);

    const later = await notice(ws.id, users.therapist, 'STAFF_APPOINTMENT_REQUEST', new Date(T0.getTime() + 10 * MIN));
    await service.processWorkspace(ws.id, new Date(T0.getTime() + 10 * MIN));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await delivery(later.id)).scheduledAt.toISOString()).toBe(new Date(T0.getTime() + 30 * MIN).toISOString());
    await service.processWorkspace(ws.id, new Date(T0.getTime() + 30 * MIN));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('N0-3 · tres fallos del proveedor → FAILED con código genérico; los logs no llevan direcciones', async () => {
    const { ws, users } = await scenario();
    const d = await notice(ws.id, users.therapist);
    const failing = jest.fn(async () => { throw Object.assign(new Error(`550 rechazado para ${'destino@example.com'}`), { code: 'EENVELOPE' }); });
    const { service } = outbox(ENV, failing as any);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: users.therapist } });
    let now = T0;
    for (let i = 0; i < 3; i++) {
      await service.processWorkspace(ws.id, now);
      const row = await delivery(d.id);
      now = new Date(row.scheduledAt.getTime());
    }
    const final = await delivery(d.id);
    expect(final).toEqual(expect.objectContaining({ status: 'FAILED', attempts: 3, errorCode: 'PROVIDER_ERROR' }));
    expect(failing).toHaveBeenCalledTimes(3);
    expect(final.scheduledAt.getTime() - T0.getTime()).toBeLessThanOrEqual(60 * MIN);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain(d.id);
    expect(logged).not.toMatch(/@|rechazado|Nueva solicitud/);
    expect(logged).not.toContain(user.email);
    warn.mockRestore();
  });

  it('N0-9 · caducada → CANCELLED / EXPIRED aunque el grupo esté apagado; nunca se envía', async () => {
    const { ws, users } = await scenario();
    const d = await notice(ws.id, users.therapist);
    const { service, send } = outbox({ ...ENV, STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'false' });
    await service.processWorkspace(ws.id, new Date(T0.getTime() + 12 * 60 * MIN + MIN));
    expect(send).not.toHaveBeenCalled();
    expect(await delivery(d.id)).toEqual(expect.objectContaining({ status: 'CANCELLED', errorCode: 'EXPIRED' }));
  });

  it('cancelaciones: ya leído en la campana, miembro dado de baja, preferencia apagada, ASSISTANT y tareas', async () => {
    const { ws, users } = await scenario();
    const read = await notice(ws.id, users.therapist);
    await prisma.notification.updateMany({ where: { workspaceId: ws.id, id: read.notificationId }, data: { status: 'READ', readAt: T0 } });
    const removed = await notice(ws.id, users.removed);
    await prisma.notificationPreference.create({ data: { workspaceId: ws.id, userId: users.assistant, emailPatientCancellations: false } });
    const off = await notice(ws.id, users.assistant, 'STAFF_PATIENT_CANCELLATION');
    const task = await notice(ws.id, users.assistant, 'STAFF_TASK_SUBMITTED');
    const { service, send } = outbox();
    await service.processWorkspace(ws.id, T0);
    expect(send).not.toHaveBeenCalled();
    expect((await delivery(read.id)).errorCode).toBe('ALREADY_READ');
    expect((await delivery(removed.id)).errorCode).toBe('RECIPIENT_INACTIVE');
    expect((await delivery(off.id)).errorCode).toBe('PREFERENCE_OFF');
    expect((await delivery(task.id)).errorCode).toBe('ROLE_NOT_ALLOWED');
  });

  it('franja silenciosa: a las 23:10 (Madrid) no sale; se aplaza a las 08:00', async () => {
    const { ws, users } = await scenario();
    const night = new Date('2030-01-15T22:10:00.000Z');
    const d = await notice(ws.id, users.therapist, 'STAFF_APPOINTMENT_REQUEST', night);
    const { service, send } = outbox();
    await service.processWorkspace(ws.id, night);
    expect(send).not.toHaveBeenCalled();
    expect((await delivery(d.id)).scheduledAt.toISOString()).toBe('2030-01-16T07:00:00.000Z');
    await service.processWorkspace(ws.id, new Date('2030-01-16T07:00:00.000Z'));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('N0-6 · dos espacios: cada email lleva solo el nombre de su espacio; enqueue rechaza avisos de otro espacio', async () => {
    const a = await scenario('Consulta A');
    const b = await scenario('Consulta B');
    await notice(a.ws.id, a.users.therapist);
    await notice(b.ws.id, b.users.therapist);
    const { service, send } = outbox();
    await service.processWorkspace(a.ws.id, T0);
    expect(send).toHaveBeenCalledTimes(1);
    const text = (send.mock.calls[0] as any)[0].text;
    expect(text).toContain(a.ws.name);
    expect(text).not.toContain(b.ws.name);
    // La entrega de B sigue intacta: una pasada de A no la toca.
    expect(await prisma.notificationDelivery.count({ where: { workspaceId: b.ws.id, status: 'PENDING' } })).toBe(1);

    const nB = await prisma.notification.create({ data: { workspaceId: b.ws.id, audience: 'PROFESSIONAL', userId: b.users.therapist, type: 'SYSTEM', title: 't', body: 'b', scheduledAt: T0, dedupeKey: `${run}-cross-${++seq}` } });
    const created = await prisma.$transaction((tx) => enqueueStaffEmails(tx, a.ws.id, [{ notificationId: nB.id, template: 'STAFF_APPOINTMENT_REQUEST' }], T0));
    expect(created).toBe(0);
    expect(await prisma.notificationDelivery.count({ where: { notificationId: nB.id } })).toBe(0);
  });

  it('N0-7 · AuditLog por espacio y pasada con recuentos, sin datos personales', async () => {
    const { ws, users } = await scenario();
    await notice(ws.id, users.therapist);
    await notice(ws.id, users.therapist);
    await notice(ws.id, users.removed);
    const { service } = outbox();
    await service.processWorkspace(ws.id, T0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId: ws.id, action: 'EMAIL_OUTBOX_PASS' } });
    expect(log.actorId).toBeNull();
    expect(log.metadata).toEqual(expect.objectContaining({ emailsSent: 1, deliveriesSent: 2, grouped: 1, cancelled: { RECIPIENT_INACTIVE: 1 } }));
    expect(JSON.stringify(log.metadata)).not.toMatch(/@|Ficticio|Consulta/);
  });

  it('entregas sin plantilla (cobros) y plantillas de paciente: nunca se envían en N0', async () => {
    const { ws, users } = await scenario();
    const patient = await prisma.patient.create({ data: { workspaceId: ws.id, firstName: 'Paciente', lastName: 'Ficticio', email: `p-${run}@example.com` } });
    const n = await prisma.notification.create({ data: { workspaceId: ws.id, audience: 'PATIENT', patientId: patient.id, type: 'INVOICE_DUE', title: 'Cobro', body: 'Importe ficticio', scheduledAt: T0, dedupeKey: `${run}-inv-${++seq}` } });
    const legacy = await prisma.notificationDelivery.create({ data: { workspaceId: ws.id, notificationId: n.id, channel: 'EMAIL', status: 'PENDING', scheduledAt: T0 } });
    const n2 = await prisma.notification.create({ data: { workspaceId: ws.id, audience: 'PATIENT', patientId: patient.id, type: 'APPOINTMENT_REMINDER', title: 'x', body: 'y', scheduledAt: T0, dedupeKey: `${run}-rem-${++seq}` } });
    const reminder = await prisma.notificationDelivery.create({ data: { workspaceId: ws.id, notificationId: n2.id, channel: 'EMAIL', status: 'PENDING', template: 'PATIENT_APPOINTMENT_REMINDER', scheduledAt: T0, expiresAt: new Date(T0.getTime() + 24 * 60 * MIN) } });
    const { service: off, send: sendOff } = outbox({ ...ENV, PATIENT_EMAIL_NOTIFICATIONS_ENABLED: 'true' }); // sin lista blanca
    await off.processWorkspace(ws.id, T0);
    expect(sendOff).not.toHaveBeenCalled();
    expect((await delivery(reminder.id)).status).toBe('PENDING');
    const { service: on, send } = outbox({ ...ENV, PATIENT_EMAIL_NOTIFICATIONS_ENABLED: 'true', PATIENT_EMAIL_WORKSPACE_ALLOWLIST: ws.id });
    await on.processWorkspace(ws.id, T0);
    expect(send).not.toHaveBeenCalled();
    expect(await delivery(reminder.id)).toEqual(expect.objectContaining({ status: 'CANCELLED', errorCode: 'TEMPLATE_UNAVAILABLE' }));
    expect(await delivery(legacy.id)).toEqual(expect.objectContaining({ status: 'PENDING', attempts: 0, claimToken: null }));
    void users;
  });

  it('N0-8 · preferencias únicas por (workspaceId, userId): el mismo usuario tiene una por espacio', async () => {
    const a = await scenario();
    const b = await scenario();
    const userId = a.users.therapist;
    await prisma.workspaceMember.create({ data: { workspaceId: b.ws.id, userId, role: 'THERAPIST', isClinician: true } });
    await prisma.notificationPreference.create({ data: { workspaceId: a.ws.id, userId, emailAppointmentRequests: false } });
    await prisma.notificationPreference.create({ data: { workspaceId: b.ws.id, userId, emailAppointmentRequests: true } });
    await expect(prisma.notificationPreference.create({ data: { workspaceId: a.ws.id, userId } })).rejects.toThrow();
    expect(await prisma.notificationPreference.count({ where: { userId } })).toBe(2);
  });
});
