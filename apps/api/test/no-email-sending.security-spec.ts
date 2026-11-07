import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EmailOutboxService } from '../src/notifications/email/email-outbox.service';
import { NotificationMailer } from '../src/notifications/email/notification-mailer';
import { PATIENT_TEMPLATES, STAFF_TEMPLATES } from '../src/notifications/email/email-templates';
import { patientRecipientEmail } from '../src/notifications/email/patient-recipient';

/**
 * REESCRITO el 07/11/2026 (N0 · avisos por email; pendiente de revisión de Argos). Antes: «la API
 * no envía correos». Ahora la API PUEDE enviar avisos por email, pero solo:
 *  - desde la bandeja de salida (src/notifications/email) y el aviso interno de la lista de espera;
 *  - con su interruptor en "true" (STAFF_EMAIL_NOTIFICATIONS_ENABLED / PATIENT_EMAIL_NOTIFICATIONS_ENABLED,
 *    apagados por defecto) y, para pacientes, solo en espacios de PATIENT_EMAIL_WORKSPACE_ALLOWLIST;
 *  - con plantillas fijas (nunca entregas sin plantilla, como las antiguas de facturación);
 *  - con un remitente único, MAIL_FROM (decisión del Jefe 07/11/2026).
 * Este archivo garantiza que, con los interruptores apagados, NO SALE NADA (ni siquiera se reserva
 * una entrega) y que nadie más usa el transporte.
 *
 * Histórico (Argos B1, 19/10/2026): Los correos de las cuentas de portal no
 * están verificados (emailVerifiedAt nulo), así que cualquier envío futuro al paciente debe pasar
 * por portalEmailUsableForDelivery (src/portal/portal-email.util.ts).
 *
 * Este test falla si aparece código de envío de email (sendMail, nodemailer, resend, @scaleway,
 * smtp) en apps/api fuera de:
 *  - un archivo que use portalEmailUsableForDelivery, o
 *  - la lista permitida explícita de abajo (p. ej. el futuro aviso de la lista de espera, que solo
 *    enviará al Jefe y nunca a pacientes). Añadir algo aquí exige revisión de Argos.
 */
const ALLOWED_WITHOUT_GATE: string[] = [
  // Aviso interno al Jefe de la lista de espera (20/10/2026, pendiente de revisión de Argos).
  // MailService solo admite los destinatarios internos de WAITLIST_NOTIFY_TO (403 con cualquier
  // otro): escribir a pacientes queda fuera de alcance y bloqueado.
  'src/mail/mail.config.ts',
  'src/mail/mail.service.ts',
  'src/mail/mail.module.ts',
  'src/waitlist/waitlist-notifier.ts',
  // Solo importa MailModule para construir el notificador (Argos M1, 21/10/2026).
  'src/waitlist/waitlist.module.ts',
  // Avisos por email (N0, 07/11/2026, pendiente de revisión de Argos): solo envían con su
  // interruptor en true; remitente único MAIL_FROM; sin plantilla no se envía nada.
  'src/notifications/email/notification-mailer.ts',
  'src/notifications/email/notification-email.config.ts',
  'src/notifications/email/email-outbox.service.ts',
  // Solo registra la factoría de NotificationMailer.
  'src/notifications/notifications.module.ts',
];
/** Dependencias de envío permitidas (versión exacta fijada en package.json). */
const ALLOWED_MAIL_DEPENDENCIES = ['nodemailer'];

const ROOT = join(__dirname, '..');
const SCAN_DIRS = ['src', 'prisma'];
// También el uso del servicio de correo propio: quien lo importe o llame a sendInternal debe estar
// en la lista permitida (Argos M1).
const PROVIDER_SENDING = /sendMail|nodemailer|\bresend\b|@scaleway|smtp/i;
// Distingue mayúsculas y exige límite de palabra: PortalAccountEmailService o email.service no cuentan.
const OWN_MAIL_SERVICE = /\bMailService\b|\bMailModule\b|\bsendInternal\b|\bNotificationMailer\b|\bsmtpTransport\b|(?<![\w-])mail\.(?:service|module)\b|notification-mailer/;
// Argos B6: también mail_service / mailService / MAIL_SERVICE (p. ej. un token de inyección).
const MAIL_SERVICE_TOKEN = /\bmail_?service\b/i;
const EMAIL_SENDING = { test: (source: string) => PROVIDER_SENDING.test(source) || OWN_MAIL_SERVICE.test(source) || MAIL_SERVICE_TOKEN.test(source) };

/** Archivos que envían (o usan el servicio de correo) sin la puerta ni la lista permitida. */
function offenders(files: { file: string; source: string }[]): string[] {
  return files
    .filter(({ source }) => EMAIL_SENDING.test(source))
    .filter(({ file, source }) => !source.includes('portalEmailUsableForDelivery') && !ALLOWED_WITHOUT_GATE.includes(file))
    .map(({ file }) => file);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'migrations') return [];
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

describe('Sin envío de email fuera de la puerta de correos verificados (Argos B1)', () => {
  it('ningún archivo de apps/api envía email sin portalEmailUsableForDelivery ni lista permitida', () => {
    const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).map((file) => ({ file: relative(ROOT, file), source: readFileSync(file, 'utf8') }));
    expect(offenders(files)).toEqual([]);
  });

  it('package.json de la API no declara librerías de envío de email sin revisión, y las permitidas van fijadas', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => EMAIL_SENDING.test(d) && !ALLOWED_MAIL_DEPENDENCIES.includes(d))).toEqual([]);
    for (const dep of ALLOWED_MAIL_DEPENDENCIES.filter((d) => d in (pkg.dependencies ?? {}))) {
      expect(pkg.dependencies[dep]).toMatch(/^\d+\.\d+\.\d+$/); // versión exacta, sin ^ ni ~
    }
  });

  it('el detector reconoce los patrones prohibidos (control del propio test)', () => {
    for (const sample of ["import nodemailer from 'nodemailer'", 'transport.sendMail(msg)', "new Resend(key)", "from '@scaleway/sdk'", 'SMTP_HOST']) {
      expect(EMAIL_SENDING.test(sample)).toBe(true);
    }
  });

  it('un archivo ficticio fuera de la lista que importa MailService o llama a sendInternal se detecta', () => {
    const samples = [
      { file: 'src/patients/aviso-ficticio.ts', source: "import { MailService } from '../mail/mail.service';" },
      { file: 'src/portal/otro-ficticio.ts', source: 'await this.mail.sendInternal({ to, subject, text });' },
      { file: 'src/sessions/modulo-ficticio.ts', source: "imports: [MailModule]" },
    ];
    expect(offenders(samples)).toEqual(samples.map((s) => s.file));
    // Y la lista permitida no es un comodín: el mismo código en un archivo permitido no cuenta.
    expect(offenders([{ file: 'src/mail/mail.service.ts', source: samples[0].source }])).toEqual([]);
    // Sin falsos positivos con nombres parecidos.
    expect(offenders([{ file: 'src/portal-signup/x.ts', source: "import { PortalAccountEmailService } from './portal-account-email.service';" }])).toEqual([]);
    expect(offenders([{ file: 'src/otro/y.ts', source: 'class EmailService {}; const emailService = new EmailService();' }])).toEqual([]);
    // B6: un token de inyección o variable mail_service / mailService fuera de la lista sí se detecta.
    const tokens = [
      { file: 'src/patients/token-ficticio.ts', source: "@Inject('MAIL_SERVICE') private readonly mail: any" },
      { file: 'src/patients/var-ficticia.ts', source: 'const mailService = this.moduleRef.get(token);' },
    ];
    expect(offenders(tokens)).toEqual(tokens.map((t) => t.file));
  });
});

// ------------------------------------------------------------------------------------------------
// Comportamiento: con los interruptores apagados no sale nada.

const SMTP_OK = {
  MAIL_SMTP_HOST: 'smtp.example.test', MAIL_SMTP_PORT: '2465', MAIL_SMTP_USER: 'usuario-ficticio', MAIL_SMTP_PASSWORD: 'secreto-ficticio',
  MAIL_FROM: 'AsePsico <avisos@notificaciones.example.test>',
};

/** BD falsa: cualquier acceso de reserva o envío queda registrado. Hay entregas de los dos grupos. */
function fakeDb() {
  const db: any = {
    notificationDelivery: {
      findMany: jest.fn(async (args: any) => (args.distinct ? [{ workspaceId: 'w1' }] : [])),
      updateMany: jest.fn(async () => ({ count: 0 })),
      findFirst: jest.fn(async () => null),
    },
    $executeRaw: jest.fn(async () => 0),
    $queryRaw: jest.fn(async () => [{ locked: true }]),
    auditLog: { create: jest.fn() },
    workspace: { findFirst: jest.fn(async () => ({ name: 'Consulta ficticia', timeZone: 'Europe/Madrid' })) },
    workspaceMember: { findFirst: jest.fn() },
    notificationPreference: { findUnique: jest.fn() },
  };
  db.$transaction = jest.fn(async (cb: any) => cb(db));
  return db;
}

function outbox(env: Record<string, string>) {
  const send = jest.fn(async () => ({ messageId: 'ref-ficticia' }));
  const factory = jest.fn(() => ({ send }));
  const mailer = new NotificationMailer(env as any, factory);
  const db = fakeDb();
  return { service: new EmailOutboxService(db, mailer), db, send, factory };
}

describe('Avisos por email: nada sale con los interruptores apagados (P-SEG-3, N0-4)', () => {
  it.each([
    ['sin variables', {}],
    ['SMTP completo pero interruptores sin definir', SMTP_OK],
    ['interruptores en "false"', { ...SMTP_OK, STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'false', PATIENT_EMAIL_NOTIFICATIONS_ENABLED: 'false', PATIENT_EMAIL_WORKSPACE_ALLOWLIST: 'w1' }],
    ['interruptores con valores ambiguos', { ...SMTP_OK, STAFF_EMAIL_NOTIFICATIONS_ENABLED: '1', PATIENT_EMAIL_NOTIFICATIONS_ENABLED: 'yes', PATIENT_EMAIL_WORKSPACE_ALLOWLIST: 'w1' }],
    ['interruptor en true pero SMTP incompleto', { STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'true', PATIENT_EMAIL_NOTIFICATIONS_ENABLED: 'true', PATIENT_EMAIL_WORKSPACE_ALLOWLIST: 'w1', MAIL_FROM: SMTP_OK.MAIL_FROM }],
  ])('%s → no se reserva ni se envía ninguna entrega', async (_label, env) => {
    const { service, db, send } = outbox(env as any);
    await service.processPass(new Date());
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('staff encendido y pacientes apagado → solo se reservan plantillas de staff', async () => {
    const { service, db } = outbox({ ...SMTP_OK, STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'true' });
    await service.processPass(new Date());
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = JSON.stringify(db.$executeRaw.mock.calls[0]);
    for (const t of STAFF_TEMPLATES) expect(sql).toContain(t);
    for (const t of PATIENT_TEMPLATES) expect(sql).not.toContain(t);
  });

  it('pacientes encendido pero el espacio no está en la lista blanca (o la lista está vacía) → nada a pacientes (P-SEG-2)', async () => {
    for (const allow of ['', 'otro-espacio']) {
      const { service, db, send } = outbox({ ...SMTP_OK, PATIENT_EMAIL_NOTIFICATIONS_ENABLED: 'true', PATIENT_EMAIL_WORKSPACE_ALLOWLIST: allow });
      await service.processPass(new Date());
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('las entregas sin plantilla (p. ej. cobros con importe) no entran nunca en la bandeja', async () => {
    const { service, db } = outbox({ ...SMTP_OK, STAFF_EMAIL_NOTIFICATIONS_ENABLED: 'true' });
    await service.processPass(new Date());
    expect(db.notificationDelivery.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ template: { not: null } }));
    expect(String(db.$executeRaw.mock.calls[0][0].strings.join(' '))).toMatch(/"template"::text = ANY/);
  });

  it('con el interruptor de un grupo apagado, el mailer se niega a enviar aunque se le llame directamente', async () => {
    const { send } = outbox(SMTP_OK);
    const mailer = new NotificationMailer(SMTP_OK as any, () => ({ send }));
    await expect(mailer.send('STAFF_APPOINTMENT_REQUEST', 'equipo@example.test', { subject: 'Asunto ficticio', text: 'Texto ficticio largo', html: '<p>x</p>' })).rejects.toThrow();
    await expect(mailer.send('PATIENT_APPOINTMENT_REMINDER', 'paciente@example.test', { subject: 'Asunto ficticio', text: 'Texto ficticio largo', html: '<p>x</p>' })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------
// Argos B5 y M2: quién puede encolar emails y de dónde sale el correo de un paciente.

const srcFiles = () => SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).map((file) => ({ file: relative(ROOT, file), source: readFileSync(file, 'utf8') }));

/** Únicos archivos que pueden encolar emails al equipo (además de donde se definen). */
const ENQUEUE_ALLOWED = [
  'src/notifications/email/email-outbox.store.ts',
  'src/notifications/email/staff-email-enqueue.ts',
  'src/notifications/appointment-change-notice.util.ts',
  'src/scheduling/appointment-request-lifecycle.util.ts',
];
const ENQUEUE = /\benqueueStaffEmails\w*\b|staff-email-enqueue|email-outbox\.store/;

describe('Argos B5: encolar emails solo desde los puntos de enganche revisados', () => {
  it('ningún otro archivo de src importa ni llama a enqueueStaffEmails*', () => {
    const offending = srcFiles().filter(({ file, source }) => ENQUEUE.test(source) && !ENQUEUE_ALLOWED.includes(file) && !file.startsWith('src/notifications/email/'))
      .map(({ file }) => file);
    expect(offending).toEqual([]);
    // Dentro de src/notifications/email solo el servicio de la bandeja usa el almacén (no lo usa para encolar).
    const inside = srcFiles().filter(({ file, source }) => file.startsWith('src/notifications/email/') && /\benqueueStaffEmails\w*\(/.test(source))
      .map(({ file }) => file).sort();
    expect(inside).toEqual(['src/notifications/email/email-outbox.store.ts', 'src/notifications/email/staff-email-enqueue.ts']);
  });

  it('el detector reconoce un enganche nuevo fuera de la lista', () => {
    expect(ENQUEUE.test("import { enqueueStaffEmailsForNotices } from '../notifications/email/staff-email-enqueue';")).toBe(true);
    expect(ENQUEUE.test('await enqueueStaffEmails(tx, ws, items);')).toBe(true);
  });
});

describe('Argos M2: el correo de un paciente solo sale de portalEmailUsableForDelivery', () => {
  it('patientRecipientEmail: solo cuenta de portal activa y verificada', () => {
    const verified = new Date();
    expect(patientRecipientEmail({ email: 'paciente@example.test', isActive: true, emailVerifiedAt: verified })).toBe('paciente@example.test');
    expect(patientRecipientEmail({ email: 'paciente@example.test', isActive: true, emailVerifiedAt: null })).toBeNull();
    expect(patientRecipientEmail({ email: 'paciente@example.test', isActive: false, emailVerifiedAt: verified })).toBeNull();
    expect(patientRecipientEmail({ email: 'liberado-x@liberado.invalid', isActive: true, emailVerifiedAt: verified })).toBeNull();
    expect(patientRecipientEmail(null)).toBeNull();
  });

  it('patient-recipient.ts usa portalEmailUsableForDelivery', () => {
    expect(readFileSync(join(ROOT, 'src/notifications/email/patient-recipient.ts'), 'utf8')).toMatch(/portalEmailUsableForDelivery\(/);
  });

  it('ningún archivo de la bandeja lee el email del paciente (ficha o portal) fuera de patient-recipient.ts', () => {
    const PATIENT_EMAIL_READ = /\b(patient|patients|portalAccount|portalAccounts|patientPortalAccount|guardian\w*)\s*:\s*\{[^}]*\bemail\b|\.(patient|portalAccount|patientPortalAccount)\??\.email\b|patientPortalAccount\.find/;
    const offending = srcFiles().filter(({ file, source }) => file.startsWith('src/notifications/email/') && file !== 'src/notifications/email/patient-recipient.ts' && PATIENT_EMAIL_READ.test(source))
      .map(({ file }) => file);
    expect(offending).toEqual([]);
    // Control del propio detector.
    expect(PATIENT_EMAIL_READ.test('select: { patient: { select: { email: true } } }')).toBe(true);
    expect(PATIENT_EMAIL_READ.test('const to = row.patient.email;')).toBe(true);
    expect(PATIENT_EMAIL_READ.test('await db.patientPortalAccount.findFirst({ where })')).toBe(true);
    expect(PATIENT_EMAIL_READ.test("select: { role: true, user: { select: { email: true } } }")).toBe(false);
  });
});

