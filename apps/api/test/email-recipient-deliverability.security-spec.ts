import { Logger } from '@nestjs/common';
import { enqueueStaffEmails } from '../src/notifications/email/email-outbox.store';
import { EmailOutboxService } from '../src/notifications/email/email-outbox.service';
import { NotificationMailer } from '../src/notifications/email/notification-mailer';
import { patientRecipientEmail } from '../src/notifications/email/patient-recipient';
import { isDeliverableStaffUser, isReservedEmailDomain, RECIPIENT_NOT_DELIVERABLE } from '../src/notifications/email/recipient-deliverability';

/**
 * Dora R1 (07/11/2026) · Nunca se envía un aviso por email a usuarios demo (User.isDemo) ni a correos
 * de dominios reservados (RFC 2606 / 6761): rebotarían y dañarían la reputación del remitente.
 * Se filtra al encolar y se vuelve a comprobar al enviar. Sin BD (la versión con PostgreSQL real está
 * en email-outbox-db.security-spec.ts). Datos 100 % ficticios.
 */

const ENV = {
  MAIL_SMTP_HOST: 'smtp.example.test', MAIL_SMTP_PORT: '2465', MAIL_SMTP_USER: 'usuario-ficticio', MAIL_SMTP_PASSWORD: 'secreto-ficticio',
  MAIL_FROM: 'AsePsico <avisos@notificaciones.example.test>', STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'true',
};
// Martes 15/01/2030 11:00 en Madrid: fuera de la franja silenciosa.
const T0 = new Date('2030-01-15T10:00:00.000Z');

describe('Dora R1 · dominios reservados (RFC 2606 / 6761)', () => {
  it.each([
    'recepcion@example.test', 'a@consulta.demo.test', 'a@example', 'a@algo.example', 'a@x.invalid', 'a@localhost', 'a@app.localhost',
    'a@example.com', 'a@EXAMPLE.COM', 'a@mail.example.com', 'a@example.net', 'a@example.org', 'a@sub.example.org', 'a@example.com.',
    '', 'sin-arroba', 'a@',
  ])('%s → reservado / no entregable', (email) => {
    expect(isReservedEmailDomain(email)).toBe(true);
  });

  it.each(['persona@pruebas.asepsico.es', 'a@gmail.com', 'a@notexample.com', 'a@example.com.es', 'a@testing.es', 'a@mi-example.org'])('%s → no reservado', (email) => {
    expect(isReservedEmailDomain(email)).toBe(false);
  });

  it('usuario entregable solo con isDemo === false y correo no reservado (si falta isDemo, no se envía)', () => {
    expect(isDeliverableStaffUser({ email: 'a@pruebas.asepsico.es', isDemo: false })).toBe(true);
    expect(isDeliverableStaffUser({ email: 'a@pruebas.asepsico.es', isDemo: true })).toBe(false);
    expect(isDeliverableStaffUser({ email: 'a@pruebas.asepsico.es' })).toBe(false);
    expect(isDeliverableStaffUser({ email: 'a@example.test', isDemo: false })).toBe(false);
    expect(isDeliverableStaffUser({ email: null, isDemo: false })).toBe(false);
    expect(isDeliverableStaffUser(null)).toBe(false);
  });

  it('el correo de un paciente de un dominio reservado tampoco sale', () => {
    const verified = new Date();
    expect(patientRecipientEmail({ email: 'paciente@example.test', isActive: true, emailVerifiedAt: verified })).toBeNull();
    expect(patientRecipientEmail({ email: 'paciente@example.com', isActive: true, emailVerifiedAt: verified })).toBeNull();
    expect(patientRecipientEmail({ email: 'paciente@pruebas.asepsico.es', isActive: true, emailVerifiedAt: verified })).toBe('paciente@pruebas.asepsico.es');
  });
});

describe('Dora R1 · al encolar', () => {
  function fakeTx(users: { id: string; email: string; isDemo: boolean }[]) {
    const notifications = users.map((u) => ({ id: `n-${u.id}`, userId: u.id }));
    return {
      notification: { findMany: jest.fn(async () => notifications) },
      user: { findMany: jest.fn(async ({ where }: any) => users.filter((u) => where.id.in.includes(u.id) && u.isDemo === where.isDemo)) },
      notificationDelivery: { createMany: jest.fn(async ({ data }: any) => ({ count: data.length })) },
    };
  }

  it('solo se crean entregas para usuarios no demo con correo no reservado; la consulta de usuarios exige isDemo: false', async () => {
    const tx = fakeTx([
      { id: 'real', email: 'terapeuta@pruebas.asepsico.es', isDemo: false },
      { id: 'demo', email: 'demo@pruebas.asepsico.es', isDemo: true },
      { id: 'reservado', email: 'recepcion@example.test', isDemo: false },
      { id: 'reservado2', email: 'otra@example.com', isDemo: false },
    ]);
    const items = ['real', 'demo', 'reservado', 'reservado2'].map((id) => ({ notificationId: `n-${id}`, template: 'STAFF_APPOINTMENT_REQUEST' as const }));
    expect(await enqueueStaffEmails(tx, 'ws-1', items, T0)).toBe(1);
    expect(tx.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isDemo: false }) }));
    const data = (tx.notificationDelivery.createMany.mock.calls[0] as any)[0].data;
    expect(data.map((d: any) => d.notificationId)).toEqual(['n-real']);
    expect(JSON.stringify(data)).not.toMatch(/@/);
  });

  it('si ningún destinatario es entregable no se escribe nada', async () => {
    const tx = fakeTx([{ id: 'demo', email: 'recepcion@example.test', isDemo: true }]);
    expect(await enqueueStaffEmails(tx, 'ws-1', [{ notificationId: 'n-demo', template: 'STAFF_PATIENT_CANCELLATION' }], T0)).toBe(0);
    expect(tx.notificationDelivery.createMany).not.toHaveBeenCalled();
  });
});

describe('Dora R1 · al enviar (segunda comprobación)', () => {
  function fakeDb(user: { email: string; isDemo: boolean }) {
    const claimed = [{
      id: 'd-1', template: 'STAFF_APPOINTMENT_REQUEST', attempts: 0,
      notification: { id: 'n-1', workspaceId: 'ws-1', audience: 'PROFESSIONAL', userId: 'u-1', patientId: null, status: 'SENT', readAt: null },
    }];
    const db: any = {
      $queryRaw: jest.fn(async () => [{ locked: true }]),
      $executeRaw: jest.fn(async () => 1),
      notificationDelivery: {
        updateMany: jest.fn(async ({ where }: any) => ({ count: where.id ? where.id.in.length : 0 })),
        findMany: jest.fn(async () => claimed),
        findFirst: jest.fn(async () => null),
      },
      workspace: { findFirst: jest.fn(async () => ({ name: 'Consulta Ficticia', timeZone: 'Europe/Madrid' })) },
      workspaceMember: { findFirst: jest.fn(async () => ({ role: 'ASSISTANT', user })) },
      notificationPreference: { findUnique: jest.fn(async () => null) },
      auditLog: { create: jest.fn() },
    };
    db.$transaction = jest.fn(async (cb: any) => cb(db));
    return db;
  }

  it.each([
    ['usuario demo', { email: 'recepcion@pruebas.asepsico.es', isDemo: true }],
    ['dominio reservado', { email: 'recepcion@example.test', isDemo: false }],
  ])('%s → no se envía y la entrega se cancela con RECIPIENT_NOT_DELIVERABLE, sin registrar la dirección', async (_label, user) => {
    const db = fakeDb(user);
    const send = jest.fn(async () => ({ messageId: '<ref@example.test>' }));
    const spies = (['log', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
    const counts = await new EmailOutboxService(db, new NotificationMailer(ENV as any, () => ({ send }))).processWorkspace('ws-1', T0);
    expect(send).not.toHaveBeenCalled();
    expect(counts.cancelled).toEqual({ [RECIPIENT_NOT_DELIVERABLE]: 1 });
    expect(db.notificationDelivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 'ws-1', id: { in: ['d-1'] } }),
      data: expect.objectContaining({ status: 'CANCELLED', errorCode: RECIPIENT_NOT_DELIVERABLE }),
    }));
    expect(db.workspaceMember.findFirst).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ user: { select: { email: true, isDemo: true } } }) }));
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toMatch(/@/);
    for (const s of spies) { expect(JSON.stringify(s.mock.calls)).not.toMatch(/@/); s.mockRestore(); }
  });

  it('usuario real con dominio no reservado → sí se envía', async () => {
    const db = fakeDb({ email: 'recepcion@pruebas.asepsico.es', isDemo: false });
    const send = jest.fn(async () => ({ messageId: '<ref@example.test>' }));
    const counts = await new EmailOutboxService(db, new NotificationMailer(ENV as any, () => ({ send }))).processWorkspace('ws-1', T0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(counts.emailsSent).toBe(1);
  });
});
