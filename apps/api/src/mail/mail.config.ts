/**
 * Configuración del correo saliente (avisos INTERNOS al equipo, hoy solo el de la lista de espera).
 * Proveedor actual: Scaleway Transactional Email (fr-par) por SMTP; el código no depende de él.
 *
 * Variables (ningún valor en el repo; ver .env.example y ops/PILOT_RUNBOOK.md):
 *   MAIL_SMTP_HOST, MAIL_SMTP_PORT (587/2587 STARTTLS exigido; 465/2465 TLS implícito), MAIL_SMTP_USER,
 *   MAIL_SMTP_PASSWORD,
 *   MAIL_FROM, WAITLIST_NOTIFY_TO, WAITLIST_NOTIFY_ENABLED (por defecto false).
 */

/**
 * Puertos admitidos. 2465/2587 son los alternativos de Scaleway TEM: el plan gratuito de Render
 * bloquea la salida a 25, 465 y 587 (desde sep-2025), así que allí se usa 2465.
 */
export const SMTP_IMPLICIT_TLS_PORTS = [465, 2465] as const;
export const SMTP_STARTTLS_PORTS = [587, 2587] as const;
export type SmtpPort = (typeof SMTP_IMPLICIT_TLS_PORTS)[number] | (typeof SMTP_STARTTLS_PORTS)[number];
const ALLOWED_SMTP_PORTS: readonly string[] = [...SMTP_STARTTLS_PORTS, ...SMTP_IMPLICIT_TLS_PORTS].map(String);

/** true si el puerto usa TLS implícito (465/2465); false si STARTTLS exigido (587/2587). */
export function isImplicitTlsPort(port: SmtpPort): boolean {
  return (SMTP_IMPLICIT_TLS_PORTS as readonly number[]).includes(port);
}

export type SmtpConfig = { host: string; port: SmtpPort; user: string; password: string };
export type MailConfig = { smtp: SmtpConfig; from: string } | null;

export class InvalidMailConfigError extends Error {}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
// Nombre visible sin < > ni caracteres de control (CR/LF incluidos: evita inyección de cabeceras),
// sin espacio inicial ni final.
const FROM_RE = /^(?:[^<>\s\x00-\x1f\x7f][^<>\x00-\x1f\x7f]{0,79} )?<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const value = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? '').trim();

/**
 * Problemas de la configuración de correo, solo con NOMBRES de variables (nunca valores). Fuente
 * única para readMailConfig (transporte) y assertMailConfig (arranque): así nunca puede pasar que
 * el arranque acepte una configuración con la que luego no se crea transporte (aviso apagado en
 * silencio). MAIL_FROM se comprueba sin recortar: un espacio o salto de línea final lo invalida.
 */
export function mailConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  for (const name of ['MAIL_SMTP_HOST', 'MAIL_SMTP_USER', 'MAIL_SMTP_PASSWORD', 'MAIL_FROM', 'WAITLIST_NOTIFY_TO']) {
    if (!value(env, name)) problems.push(`${name} (falta)`);
  }
  const port = value(env, 'MAIL_SMTP_PORT');
  if (!port) problems.push('MAIL_SMTP_PORT (falta)');
  else if (!ALLOWED_SMTP_PORTS.includes(port)) problems.push('MAIL_SMTP_PORT (solo 587, 465, 2587 o 2465)');
  const from = env.MAIL_FROM ?? '';
  if (value(env, 'MAIL_FROM') && !FROM_RE.test(from)) problems.push('MAIL_FROM (formato: "Nombre <direccion@dominio>", sin espacios ni saltos de línea al principio o al final)');
  const to = internalRecipients(env);
  if (to.length && !to.every((r) => EMAIL_RE.test(r))) problems.push('WAITLIST_NOTIFY_TO (direcciones no válidas)');
  if (/[\x00-\x1f\x7f]/.test(value(env, 'MAIL_SMTP_HOST'))) problems.push('MAIL_SMTP_HOST (caracteres no válidos)');
  if (/[\x00-\x1f\x7f]/.test(value(env, 'MAIL_SMTP_USER'))) problems.push('MAIL_SMTP_USER (caracteres no válidos)');
  return problems;
}

/** Transporte SMTP solo si la configuración no tiene ningún problema; si no, null (sin transporte). */
export function readMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  if (mailConfigProblems(env).length) return null;
  return {
    smtp: { host: value(env, 'MAIL_SMTP_HOST'), port: Number(value(env, 'MAIL_SMTP_PORT')) as SmtpPort, user: value(env, 'MAIL_SMTP_USER'), password: env.MAIL_SMTP_PASSWORD ?? '' },
    from: env.MAIL_FROM ?? '',
  };
}

export function waitlistNotifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return value(env, 'WAITLIST_NOTIFY_ENABLED').toLowerCase() === 'true';
}

/** Destinatarios internos permitidos (lista separada por comas). */
export function internalRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  return value(env, 'WAITLIST_NOTIFY_TO').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
}

/**
 * Al arrancar (main.ts): con WAITLIST_NOTIFY_ENABLED=true, falta o error de formato → error con los
 * NOMBRES de las variables, nunca sus valores. Con el aviso apagado no se exige nada.
 */
export function assertMailConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!waitlistNotifyEnabled(env)) return;
  const problems = mailConfigProblems(env);
  if (problems.length) {
    throw new InvalidMailConfigError(`WAITLIST_NOTIFY_ENABLED=true pero la configuración de correo no es válida: ${problems.join(', ')}`);
  }
}
