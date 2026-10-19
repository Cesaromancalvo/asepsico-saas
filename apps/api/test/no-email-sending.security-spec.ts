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
const ALLOWED_WITHOUT_GATE: string[] = [];

const ROOT = join(__dirname, '..');
const SCAN_DIRS = ['src', 'prisma'];
const EMAIL_SENDING = /sendMail|nodemailer|\bresend\b|@scaleway|smtp/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'migrations') return [];
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

describe('Sin envío de email fuera de la puerta de correos verificados (Argos B1)', () => {
  it('ningún archivo de apps/api envía email sin portalEmailUsableForDelivery ni lista permitida', () => {
    const offenders = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))
      .filter((file) => EMAIL_SENDING.test(readFileSync(file, 'utf8')))
      .map((file) => ({ file: relative(ROOT, file), source: readFileSync(file, 'utf8') }))
      .filter(({ file, source }) => !source.includes('portalEmailUsableForDelivery') && !ALLOWED_WITHOUT_GATE.includes(file))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('package.json de la API no declara librerías de envío de email sin revisión', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => EMAIL_SENDING.test(d))).toEqual([]);
  });

  it('el detector reconoce los patrones prohibidos (control del propio test)', () => {
    for (const sample of ["import nodemailer from 'nodemailer'", 'transport.sendMail(msg)', "new Resend(key)", "from '@scaleway/sdk'", 'SMTP_HOST']) {
      expect(EMAIL_SENDING.test(sample)).toBe(true);
    }
  });
});
