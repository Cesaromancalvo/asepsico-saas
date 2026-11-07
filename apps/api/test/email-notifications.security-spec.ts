import { NotificationMailer } from '../src/notifications/email/notification-mailer';
import { renderStaffEmail, STAFF_TEMPLATES, PATIENT_TEMPLATES, templateGroup } from '../src/notifications/email/email-templates';
import { assertNotificationEmailConfig, groupEnabledFor, readNotificationEmailConfig } from '../src/notifications/email/notification-email.config';
import { quietHoursEnd } from '../src/notifications/email/email-outbox.service';
import { defaultFor, staffEmailPreferenceView, wantsStaffEmail } from '../src/notifications/email/staff-email-preferences';
import { NotificationsService } from '../src/notifications/notifications.service';
import { patientSubject, renderPatientEmail } from '../src/notifications/email/patient-email-layout';
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

describe('N0-5 / M7 · remitente por tipo de destinatario (hoy la misma dirección, MAIL_FROM)', () => {
  const PATIENT_TEMPLATE_CALLS = async (mailer: NotificationMailer, name?: string) => {
    for (const t of PATIENT_TEMPLATES) await mailer.send(t, 'paciente@example.test', mail, name);
  };

  it('equipo → MAIL_FROM; pacientes → «Avisos de cita» con la dirección de MAIL_FROM si no hay PATIENT_MAIL_FROM', async () => {
    const send = jest.fn(async () => ({ messageId: '<ref@x>' }));
    const mailer = new NotificationMailer(BASE as any, () => ({ send }));
    for (const t of STAFF_TEMPLATES) await (mailer.send as any)(t, 'equipo@example.test', mail, 'Remitente inyectado <x@example.test>');
    await PATIENT_TEMPLATE_CALLS(mailer);
    const calls = send.mock.calls.map((c: any) => c[0]);
    for (const m of calls.filter((m: any) => m.to.startsWith('equipo'))) expect(m.from).toBe(BASE.MAIL_FROM);
    for (const m of calls.filter((m: any) => m.to.startsWith('paciente'))) expect(m.from).toBe('Avisos de cita <avisos@notificaciones.example.test>');
    for (const m of calls) expect(Object.keys(m).sort()).toEqual(['from', 'html', 'subject', 'text', 'to']);
  });

  it('con PATIENT_MAIL_FROM los pacientes cambian de dirección sin tocar código; el equipo no cambia', async () => {
    const send = jest.fn(async () => ({ messageId: '<ref@x>' }));
    const mailer = new NotificationMailer({ ...BASE, PATIENT_MAIL_FROM: 'no-responder@neutro-ficticio.test' } as any, () => ({ send }));
    await mailer.send('STAFF_APPOINTMENT_REQUEST', 'equipo@example.test', mail);
    await PATIENT_TEMPLATE_CALLS(mailer, 'Consulta Ficticia');
    const calls = send.mock.calls.map((c: any) => c[0]);
    expect(calls[0].from).toBe(BASE.MAIL_FROM);
    for (const m of calls.slice(1)) expect(m.from).toBe('Consulta Ficticia <no-responder@neutro-ficticio.test>');
  });

  it('M1: el nombre visible del remitente de pacientes nunca es AsePsico ni revela el tipo de cita', async () => {
    const send = jest.fn(async () => ({ messageId: '<ref@x>' }));
    const mailer = new NotificationMailer(BASE as any, () => ({ send }));
    for (const name of [null, '', 'AsePsico', 'Centro de Psicología Ficticio', 'Terapia Ficticia', 'Clínica Ficticia', 'Salud Mental X', 'Ficticio\r\nBcc: x@example.test', '"<x@example.test>"']) {
      const from = mailer.senderFor('PATIENT_APPOINTMENT_REMINDER', name);
      const display = from.slice(0, from.lastIndexOf(' <'));
      expect(from.endsWith(' <avisos@notificaciones.example.test>')).toBe(true);
      expect(display).not.toMatch(/asepsico|psico|terap|cl[ií]nic|salud|[\r\n"<>]/i);
      expect(display.length).toBeGreaterThan(0);
    }
    expect(mailer.senderFor('PATIENT_APPOINTMENT_REMINDER', 'AsePsico')).toBe('Avisos de cita <avisos@notificaciones.example.test>');
    expect(mailer.senderFor('PATIENT_APPOINTMENT_REMINDER', 'Consulta Norte')).toBe('Consulta Norte <avisos@notificaciones.example.test>');
  });

  it('PATIENT_MAIL_FROM mal formado → la API no arranca y nombra la variable', () => {
    expect(() => assertNotificationEmailConfig({ ...BASE, PATIENT_MAIL_FROM: 'no es\r\nuna dirección' } as any)).toThrow(/PATIENT_MAIL_FROM/);
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

describe('M2–M3 · molde de los emails a pacientes (aún apagados)', () => {
  const tz = 'Europe/Madrid';
  const startsAt = new Date('2026-11-10T09:00:00Z'); // martes 10 de noviembre, 10:00 en Madrid

  it('M2: el asunto es un prefijo fijo + solo fecha y hora (P2b, sin fecha)', () => {
    expect(patientSubject('PATIENT_APPOINTMENT_REMINDER', startsAt, tz)).toBe('Recordatorio de cita: martes 10 de noviembre, 10:00');
    expect(patientSubject('PATIENT_REQUEST_ACCEPTED', startsAt, tz)).toBe('Cita confirmada: martes 10 de noviembre, 10:00');
    expect(patientSubject('PATIENT_APPOINTMENT_CHANGED', startsAt, tz)).toBe('Tu cita ha cambiado: martes 10 de noviembre, 10:00');
    expect(patientSubject('PATIENT_APPOINTMENT_CANCELLED', startsAt, tz)).toBe('Cita cancelada: martes 10 de noviembre, 10:00');
    expect(patientSubject('PATIENT_REQUEST_REJECTED', startsAt, tz)).toBe('Respuesta a tu solicitud de cita');
  });

  it('M3: la primera línea (vista previa) es neutra; AsePsico solo aparece en el pie; sin logo ni seguimiento', () => {
    const email = renderPatientEmail({
      template: 'PATIENT_APPOINTMENT_REMINDER', startsAt, timeZone: tz, greeting: 'Hola, Nombre:',
      lines: ['Tienes una cita el martes 10 de noviembre a las 10:00 (hora peninsular).', 'Si no puedes venir, avisa a tu consulta.'],
      portalUrl: 'https://portal.example.test',
    });
    const [beforeFooter, footer] = email.text.split('\n--\n');
    expect(beforeFooter.split('\n')[0]).toBe('Tienes una cita el martes 10 de noviembre a las 10:00 (hora peninsular).');
    expect(`${email.subject}\n${beforeFooter}`).not.toMatch(/asepsico|psico|terap|cl[ií]nic|salud/i);
    expect(footer).toContain('AsePsico');
    expect(email.html.indexOf('AsePsico')).toBeGreaterThan(email.html.indexOf('<hr>'));
    expect(email.html.replace(/<[^>]+>/g, '\n').trim().split('\n').find(Boolean)).toBe('Tienes una cita el martes 10 de noviembre a las 10:00 (hora peninsular).');
    expect(email.html).not.toMatch(/<img|<script|background=|url\(|\?[a-z_]+=/i);
  });

  it('M3: una primera línea, saludo o asunto no neutros se rechazan', () => {
    const base = { template: 'PATIENT_APPOINTMENT_REMINDER' as const, startsAt, timeZone: tz, greeting: 'Hola:' };
    expect(() => renderPatientEmail({ ...base, lines: ['Tu sesión de terapia en AsePsico'] })).toThrow();
    expect(() => renderPatientEmail({ ...base, greeting: 'Hola, paciente de psicología:', lines: ['Tienes una cita.'] })).toThrow();
    expect(() => renderPatientEmail({ ...base, lines: [] })).toThrow();
  });

  it('enlace al portal solo si es fijo (https, sin parámetros)', () => {
    const email = renderPatientEmail({ template: 'PATIENT_APPOINTMENT_REMINDER', startsAt, timeZone: tz, greeting: 'Hola:', lines: ['Tienes una cita.'], portalUrl: 'https://portal.example.test/?cita=1' });
    expect(email.text).not.toContain('portal.example.test');
  });
});
