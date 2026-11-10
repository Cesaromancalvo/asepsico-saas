import { Logger } from '@nestjs/common';
import { enqueueStaffEmails } from '../src/notifications/email/email-outbox.store';
import { EmailOutboxService } from '../src/notifications/email/email-outbox.service';
import { NotificationMailer } from '../src/notifications/email/notification-mailer';
import { patientRecipientEmail } from '../src/notifications/email/patient-recipient';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  allowReservedRecipientDomainsInTests, isBlockedRecipientEmail, isDeliverableStaffUser, isReservedEmailDomain, RECIPIENT_NOT_DELIVERABLE,
} from '../src/notifications/email/recipient-deliverability';
import { allowTestRecipientDomain, TEST_RECIPIENT_DOMAIN } from './support/test-recipient-domain';

/**
 * Dora R1 (07/11/2026) · Nunca se envía un aviso por email a usuarios demo (User.isDemo) ni a correos
 * de dominios reservados (RFC 2606 / 6761): rebotarían y dañarían la reputación del remitente.
 * Se filtra al encolar y se vuelve a comprobar al enviar. Sin BD (la versión con PostgreSQL real está
 * en email-outbox-db.security-spec.ts). Datos 100 % ficticios.
 *
 * Argos C1 (08/11/2026): los tests usan correos del dominio reservado TEST_RECIPIENT_DOMAIN, que nunca
 * puede entregarse. Por defecto R1 lo bloquea como a cualquier reservado; solo un test lo permite,
 * explícitamente y dentro de Jest (allowReservedRecipientDomainsInTests). Sin variable de entorno.
 */
const TEST_EMAIL = (local: string) => `${local}@${TEST_RECIPIENT_DOMAIN}`;

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

  it.each(['a@gmail.com', 'a@notexample.com', 'a@example.com.es', 'a@testing.es', 'a@mi-example.org'])('%s → no reservado', (email) => {
    expect(isReservedEmailDomain(email)).toBe(false);
  });

  it('camino normal: el dominio de tests es reservado y R1 lo bloquea como a cualquier otro', () => {
    expect(isReservedEmailDomain(TEST_EMAIL('a'))).toBe(true);
    expect(isBlockedRecipientEmail(TEST_EMAIL('a'))).toBe(true);
    expect(isDeliverableStaffUser({ email: TEST_EMAIL('a'), isDemo: false })).toBe(false);
    expect(patientRecipientEmail({ email: TEST_EMAIL('paciente'), isActive: true, emailVerifiedAt: new Date() })).toBeNull();
  });

  it('usuario entregable solo con isDemo === false y correo no reservado (si falta isDemo, no se envía)', () => {
    expect(isDeliverableStaffUser({ email: 'a@example.test', isDemo: false })).toBe(false);
    expect(isDeliverableStaffUser({ email: 'a@example.test', isDemo: true })).toBe(false);
    expect(isDeliverableStaffUser({ email: null, isDemo: false })).toBe(false);
    expect(isDeliverableStaffUser(null)).toBe(false);
  });

  it('el correo de un paciente de un dominio reservado tampoco sale', () => {
    const verified = new Date();
    expect(patientRecipientEmail({ email: 'paciente@example.test', isActive: true, emailVerifiedAt: verified })).toBeNull();
    expect(patientRecipientEmail({ email: 'paciente@example.com', isActive: true, emailVerifiedAt: verified })).toBeNull();
  });
});

describe('Argos C1 · excepción de tests para el dominio reservado de tests', () => {
  afterEach(() => allowReservedRecipientDomainsInTests([]));

  it('permitido explícitamente: solo ese dominio exacto; isDemo y los demás reservados siguen bloqueando', () => {
    allowReservedRecipientDomainsInTests([TEST_RECIPIENT_DOMAIN]);
    const verified = new Date();
    expect(isDeliverableStaffUser({ email: TEST_EMAIL('a'), isDemo: false })).toBe(true);
    expect(isDeliverableStaffUser({ email: TEST_EMAIL('a').toUpperCase(), isDemo: false })).toBe(true);
    expect(isDeliverableStaffUser({ email: TEST_EMAIL('a'), isDemo: true })).toBe(false);
    expect(isDeliverableStaffUser({ email: TEST_EMAIL('a') })).toBe(false);
    expect(patientRecipientEmail({ email: TEST_EMAIL('paciente'), isActive: true, emailVerifiedAt: verified })).toBe(TEST_EMAIL('paciente'));
    for (const other of [`a@sub.${TEST_RECIPIENT_DOMAIN}`, 'a@example.test', 'a@example.com', 'a@x.invalid', 'a@localhost', '', 'sin-arroba', `a@`]) {
      expect(isBlockedRecipientEmail(other)).toBe(true);
    }
  });

  it('fuera de Jest no se puede activar, y si ya estaba activa deja de valer', () => {
    const env = { NODE_ENV: process.env.NODE_ENV, JEST_WORKER_ID: process.env.JEST_WORKER_ID };
    try {
      allowReservedRecipientDomainsInTests([TEST_RECIPIENT_DOMAIN]);
      process.env.NODE_ENV = 'production';
      expect(isDeliverableStaffUser({ email: TEST_EMAIL('a'), isDemo: false })).toBe(false);
      expect(() => allowReservedRecipientDomainsInTests([TEST_RECIPIENT_DOMAIN])).toThrow(/solo puede usarse en tests/);
      process.env.NODE_ENV = 'test';
      delete process.env.JEST_WORKER_ID;
      expect(isDeliverableStaffUser({ email: TEST_EMAIL('a'), isDemo: false })).toBe(false);
      expect(() => allowReservedRecipientDomainsInTests([TEST_RECIPIENT_DOMAIN])).toThrow(/solo puede usarse en tests/);
    } finally {
      process.env.NODE_ENV = env.NODE_ENV;
      if (env.JEST_WORKER_ID === undefined) delete process.env.JEST_WORKER_ID; else process.env.JEST_WORKER_ID = env.JEST_WORKER_ID;
    }
  });

  it('solo admite dominios reservados (nunca sirve para «permitir» uno real)', () => {
    expect(() => allowReservedRecipientDomainsInTests(['gmail.com'])).toThrow(/dominios reservados/);
    expect(() => allowReservedRecipientDomainsInTests([''])).toThrow(/dominios reservados/);
  });

  it('ningún archivo de src activa la excepción (solo la define recipient-deliverability.ts)', () => {
    const ROOT = join(__dirname, '..');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const offenders = walk(join(ROOT, 'src'))
      .filter((f) => /\.ts$/.test(f))
      .map((f) => relative(ROOT, f).split('\\').join('/'))
      .filter((f) => f !== 'src/notifications/email/recipient-deliverability.ts')
      .filter((f) => /allowReservedRecipientDomainsInTests|reservedDomainsAllowedInTests/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('Dora R1 · al encolar', () => {
  allowTestRecipientDomain();
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
      { id: 'real', email: TEST_EMAIL('terapeuta'), isDemo: false },
      { id: 'demo', email: TEST_EMAIL('demo'), isDemo: true },
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
  allowTestRecipientDomain();
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
    ['usuario demo', { email: TEST_EMAIL('recepcion'), isDemo: true }],
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

  it('usuario real con el dominio de tests permitido → sí se envía (transporte falso)', async () => {
    const db = fakeDb({ email: TEST_EMAIL('recepcion'), isDemo: false });
    const send = jest.fn(async () => ({ messageId: '<ref@example.test>' }));
    const counts = await new EmailOutboxService(db, new NotificationMailer(ENV as any, () => ({ send }))).processWorkspace('ws-1', T0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(counts.emailsSent).toBe(1);
  });
});
