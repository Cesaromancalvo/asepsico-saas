import { NotificationMailer } from '../src/notifications/email/notification-mailer';
import { renderStaffEmail, STAFF_TEMPLATES, PATIENT_TEMPLATES, templateGroup } from '../src/notifications/email/email-templates';
import { assertNotificationEmailConfig, groupEnabledFor, readNotificationEmailConfig } from '../src/notifications/email/notification-email.config';
import { quietHoursEnd } from '../src/notifications/email/email-outbox.service';
import { defaultFor, staffEmailPreferenceView, wantsStaffEmail } from '../src/notifications/email/staff-email-preferences';
import { NotificationsService } from '../src/notifications/notifications.service';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * N0 · Infraestructura común de avisos por email (sin BD). Datos 100 % ficticios.
 * La parte con PostgreSQL real (reserva, concurrencia, reintentos, caducidad…) está en
 * email-outbox-db.security-spec.ts.
 */

const SECRET = 'secreto-ficticio-no-sale';
const BASE = {
  MAIL_SMTP_HOST: 'smtp.example.test', MAIL_SMTP_PORT: '2465', MAIL_SMTP_USER: 'usuario-ficticio', MAIL_SMTP_PASSWORD: SECRET,
  MAIL_FROM: 'AsePsico <avisos@notificaciones.example.test>',
  STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'true', PATIENT_EMAIL_NOTIFICATIONS_ENABLED: 'true', PATIENT_EMAIL_WORKSPACE_ALLOWLIST: 'w-demo',
};
const mail = { subject: 'Asunto ficticio largo', text: 'Cuerpo ficticio largo', html: '<p>Cuerpo</p>' };

describe('N0-5 (decisión del Jefe 07/11) · remitente único: todos los emails salen de MAIL_FROM', () => {
  it('staff y pacientes salen de MAIL_FROM; no hay forma de pasar otro remitente', async () => {
    const send = jest.fn(async () => ({ messageId: '<ref@x>' }));
    const mailer = new NotificationMailer({ ...BASE, STAFF_MAIL_FROM: 'Otro <otro@example.test>', PATIENT_MAIL_FROM: 'otro@neutro.test' } as any, () => ({ send }));
    for (const t of [...STAFF_TEMPLATES, ...PATIENT_TEMPLATES]) await (mailer.send as any)(t, 'destino@example.test', mail, 'Remitente inyectado <x@example.test>');
    expect(send).toHaveBeenCalledTimes(STAFF_TEMPLATES.length + PATIENT_TEMPLATES.length);
    for (const call of send.mock.calls as any[]) {
      expect(call[0].from).toBe(BASE.MAIL_FROM);
      expect(Object.keys(call[0]).sort()).toEqual(['from', 'html', 'subject', 'text', 'to']);
    }
  });

  it('MAIL_FROM ausente o con saltos de línea → no se envía nada y, con un interruptor encendido, la API no arranca', async () => {
    for (const from of [undefined, 'AsePsico\r\nBcc: x@example.test <avisos@example.test>']) {
      const env = { ...BASE, MAIL_FROM: from } as any;
      const send = jest.fn();
      const mailer = new NotificationMailer(env, () => ({ send }));
      expect(groupEnabledFor(mailer.config, 'STAFF', 'w1')).toBe(false);
      await expect(mailer.send('STAFF_APPOINTMENT_REQUEST', 'equipo@example.test', mail)).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
      expect(() => assertNotificationEmailConfig(env)).toThrow(/MAIL_FROM/);
    }
  });

  it('el error de arranque nombra variables y nunca muestra valores', () => {
    let error: any;
    try { assertNotificationEmailConfig({ STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'true', MAIL_SMTP_PASSWORD: SECRET, MAIL_SMTP_PORT: '25' } as any); } catch (e) { error = e; }
    expect(error.message).toContain('MAIL_SMTP_HOST');
    expect(error.message).not.toContain(SECRET);
    expect(() => assertNotificationEmailConfig({} as any)).not.toThrow();
  });

  it('un grupo apagado no afecta al otro (N0-4) y la lista blanca de pacientes manda (P-SEG-2)', () => {
    const staffOnly = readNotificationEmailConfig({ ...BASE, PATIENT_EMAIL_NOTIFICATIONS_ENABLED: 'false' } as any);
    expect([groupEnabledFor(staffOnly, 'STAFF', 'w1'), groupEnabledFor(staffOnly, 'PATIENT', 'w-demo')]).toEqual([true, false]);
    const patientOnly = readNotificationEmailConfig({ ...BASE, STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'false' } as any);
    expect([groupEnabledFor(patientOnly, 'STAFF', 'w1'), groupEnabledFor(patientOnly, 'PATIENT', 'w-demo'), groupEnabledFor(patientOnly, 'PATIENT', 'w1')]).toEqual([false, true, false]);
    const staffAllow = readNotificationEmailConfig({ ...BASE, STAFF_EMAIL_WORKSPACE_ALLOWLIST: 'w1' } as any);
    expect([groupEnabledFor(staffAllow, 'STAFF', 'w1'), groupEnabledFor(staffAllow, 'STAFF', 'w2')]).toEqual([true, false]);
  });

  it('cada plantilla pertenece a un único grupo', () => {
    for (const t of STAFF_TEMPLATES) expect(templateGroup(t)).toBe('STAFF');
    for (const t of PATIENT_TEMPLATES) expect(templateGroup(t)).toBe('PATIENT');
    expect(() => templateGroup('OTRA' as any)).toThrow();
  });
});

describe('Plantillas de staff (§4.2, Lex 07/11)', () => {
  it('texto fijo con el nombre del espacio, enlaces fijos y pie con «no respondas»', () => {
    const one = renderStaffEmail(['STAFF_APPOINTMENT_REQUEST'], 'Consulta Ficticia', 'https://app.example.test');
    expect(one.subject).toBe('Nueva solicitud de cita en AsePsico');
    expect(one.text).toContain('Tienes una solicitud de cita nueva en Consulta Ficticia. Entra en AsePsico para verla.');
    expect(one.text).toContain('Es un aviso automático: no respondas a este correo.');
    expect(one.text).toContain('Puedes desactivarlos en Mi cuenta.');
    for (const part of [one.text, one.html]) {
      const links = part.match(/https?:\/\/[^\s"<]+/g) ?? [];
      expect(links.length).toBeGreaterThan(0);
      for (const l of links) expect(l).toMatch(/^https:\/\/app\.example\.test\/(settings\/email-notifications)?$/);
    }
    expect(one.html).not.toMatch(/<img|<script|https?:\/\/(?!app\.example\.test)/i);
  });

  it('agrupa varias entregas en un email con recuentos', () => {
    const many = renderStaffEmail(['STAFF_APPOINTMENT_REQUEST', 'STAFF_APPOINTMENT_REQUEST', 'STAFF_PATIENT_CANCELLATION'], 'Consulta Ficticia', 'https://app.example.test');
    expect(many.subject).toBe('Tienes novedades en AsePsico');
    expect(many.text).toContain('Tienes novedades en Consulta Ficticia: 2 solicitudes de cita nuevas, 1 cancelación. Entra en AsePsico para verlas.');
  });

  it('el nombre del espacio no puede inyectar HTML ni líneas', () => {
    const r = renderStaffEmail(['STAFF_TASK_SUBMITTED'], 'Consulta <b>X</b>\r\nBcc: a@b', 'https://app.example.test');
    expect(r.html).not.toContain('<b>X</b>');
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.text.split('\n')[0]).not.toMatch(/\r/);
  });

  it('el render no recibe datos del paciente: su firma solo admite plantillas y nombre del espacio', () => {
    expect(renderStaffEmail.length).toBe(3);
  });
});

describe('N0-10 · el código de envío no lee contenido clínico ni texto libre', () => {
  const dir = join(__dirname, '..', 'src', 'notifications', 'email');
  const sources = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''));
  it.each(['clinicalProcess', 'therapeuticTask', 'invoice', 'privateNote', 'notes', 'title:', 'body:', 'firstName', 'lastName', 'rejectionReason'])('no aparece «%s»', (word) => {
    for (const src of sources) expect(src).not.toContain(word);
  });
  it('metadata solo se escribe (recuentos del AuditLog), nunca se lee de la Notification', () => {
    for (const src of sources) for (const m of src.match(/.*metadata.*/g) ?? []) expect(m.trim()).toBe('data: { workspaceId, actorId: null, action: \'EMAIL_OUTBOX_PASS\', entityType: \'NotificationDelivery\', metadata: counts },');
  });
  it('los logs solo llevan id de entrega y código (nunca to, subject ni email)', () => {
    for (const src of sources) {
      for (const line of src.split('\n').filter((l) => /logger\.(log|warn|error|debug)/.test(l))) {
        expect(line).not.toMatch(/\bto\b|subject|email\.|\.email|text|html/);
      }
    }
  });
});

describe('Franja silenciosa 21:00–08:00 (Europe/Madrid)', () => {
  const tz = 'Europe/Madrid';
  it.each([
    ['2026-11-10T09:00:00Z', null], // 10:00 Madrid
    ['2026-11-10T19:59:00Z', null], // 20:59
    ['2026-11-10T20:00:00Z', '2026-11-11T07:00:00.000Z'], // 21:00 → 08:00 del día siguiente
    ['2026-11-10T22:10:00Z', '2026-11-11T07:00:00.000Z'], // 23:10 → 08:00
    ['2026-11-11T05:30:00Z', '2026-11-11T07:00:00.000Z'], // 06:30 → 08:00 del mismo día
    ['2026-03-28T21:30:00Z', '2026-03-29T06:00:00.000Z'], // noche del cambio de hora de marzo
  ])('%s → %s', (now, expected) => {
    const end = quietHoursEnd(new Date(now), tz);
    expect(end ? end.toISOString() : null).toBe(expected);
  });
});

describe('Preferencias de email del equipo (§7) y N4', () => {
  it('defaults por rol', () => {
    expect(defaultFor('appointmentRequests', 'THERAPIST', true)).toBe(true);
    expect(defaultFor('appointmentRequests', 'THERAPIST', false)).toBe(false);
    expect(defaultFor('appointmentRequests', 'ASSISTANT', false)).toBe(true);
    expect(defaultFor('appointmentRequests', 'OWNER', true)).toBe(true);
    expect(defaultFor('appointmentRequests', 'OWNER', false)).toBe(false);
    expect(defaultFor('taskSubmitted', 'THERAPIST', true)).toBe(false);
    expect(wantsStaffEmail({ emailTaskSubmitted: true }, 'taskSubmitted', 'ASSISTANT', false)).toBe(false);
    expect(wantsStaffEmail({ emailAppointmentRequests: true }, 'appointmentRequests', 'OWNER', false)).toBe(true);
    expect(wantsStaffEmail({ emailAppointmentRequests: false }, 'appointmentRequests', 'ASSISTANT', false)).toBe(false);
    expect(staffEmailPreferenceView(null, 'ASSISTANT').taskSubmitted).toEqual({ enabled: false, isDefault: true, available: false });
  });

  function prismaFake() {
    const db: any = {
      notificationPreference: { findUnique: jest.fn(async () => null), upsert: jest.fn(async ({ create }: any) => ({ id: 'pref1', ...create })) },
      auditLog: { create: jest.fn() },
    };
    db.$transaction = jest.fn(async (cb: any) => cb(db));
    return db;
  }

  it('PATCH propias: filtra por workspaceId + userId del token y audita en la transacción', async () => {
    const db = prismaFake();
    const actor = { sub: 'u1', workspaceId: 'w1', role: 'THERAPIST' };
    await new NotificationsService(db).updateStaffEmailPreferences(actor, { appointmentRequests: false, taskSubmitted: true });
    expect(db.notificationPreference.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId_userId: { workspaceId: 'w1', userId: 'u1' } } }));
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ workspaceId: 'w1', actorId: 'u1', action: 'STAFF_EMAIL_PREFERENCES_UPDATED' }) });
  });

  it('ASSISTANT no puede encender «Tareas entregadas» (403) y no se escribe nada', async () => {
    const db = prismaFake();
    await expect(new NotificationsService(db).updateStaffEmailPreferences({ sub: 'a1', workspaceId: 'w1', role: 'ASSISTANT' }, { taskSubmitted: true })).rejects.toThrow(/rol/);
    expect(db.notificationPreference.upsert).not.toHaveBeenCalled();
  });

  it('preferencias del canal clásico: por espacio (un usuario en dos espacios tiene dos filas)', async () => {
    const db = prismaFake();
    const service = new NotificationsService(db);
    await service.getProfessionalPreferences({ sub: 'u1', workspaceId: 'w2' });
    expect(db.notificationPreference.findUnique).toHaveBeenCalledWith({ where: { workspaceId_userId: { workspaceId: 'w2', userId: 'u1' } } });
  });
});
