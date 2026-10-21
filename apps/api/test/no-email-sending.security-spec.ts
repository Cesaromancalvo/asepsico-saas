import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Argos B1 (19/10/2026): hoy la API no envía correos. Los correos de las cuentas de portal no
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
];
/** Dependencias de envío permitidas (versión exacta fijada en package.json). */
const ALLOWED_MAIL_DEPENDENCIES = ['nodemailer'];

const ROOT = join(__dirname, '..');
const SCAN_DIRS = ['src', 'prisma'];
// También el uso del servicio de correo propio: quien lo importe o llame a sendInternal debe estar
// en la lista permitida (Argos M1).
const PROVIDER_SENDING = /sendMail|nodemailer|\bresend\b|@scaleway|smtp/i;
// Distingue mayúsculas y exige límite de palabra: PortalAccountEmailService o email.service no cuentan.
const OWN_MAIL_SERVICE = /\bMailService\b|\bMailModule\b|\bsendInternal\b|(?<![\w-])mail\.(?:service|module)\b/;
const EMAIL_SENDING = { test: (source: string) => PROVIDER_SENDING.test(source) || OWN_MAIL_SERVICE.test(source) };

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
  });
});
