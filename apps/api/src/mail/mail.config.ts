/**
 * Configuración del correo saliente (avisos INTERNOS al equipo, hoy solo el de la lista de espera).
 * Proveedor actual: Scaleway Transactional Email (fr-par) por SMTP; el código no depende de él.
 *
 * Variables (ningún valor en el repo; ver .env.example y ops/PILOT_RUNBOOK.md):
 *   MAIL_SMTP_HOST, MAIL_SMTP_PORT (587 STARTTLS o 465 TLS), MAIL_SMTP_USER, MAIL_SMTP_PASSWORD,
 *   MAIL_FROM, WAITLIST_NOTIFY_TO, WAITLIST_NOTIFY_ENABLED (por defecto false).
 */

export type SmtpConfig = { host: string; port: 465 | 587; user: string; password: string };
export type MailConfig = { smtp: SmtpConfig; from: string } | null;

export class InvalidMailConfigError extends Error {}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
// Nombre visible sin < > ni caracteres de control (CR/LF incluidos: evita inyección de cabeceras).
const FROM_RE = /^(?:[^<>\x00-\x1f\x7f]{1,80} )?<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const value = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? '').trim();

/**
 * Transporte SMTP solo si están TODAS las variables y son válidas (remitente con FROM_RE y cada
 * destinatario interno con EMAIL_RE); si no, null y no se crea transporte. Así MailService no
 * depende de que main.ts haya llamado a assertMailConfig.
 */
export function readMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const host = value(env, 'MAIL_SMTP_HOST');
  const port = Number(value(env, 'MAIL_SMTP_PORT'));
  const user = value(env, 'MAIL_SMTP_USER');
  const password = env.MAIL_SMTP_PASSWORD ?? '';
  // Sin trim: un CR/LF al final del remitente también invalida la configuración.
  const from = env.MAIL_FROM ?? '';
  if (!host || !user || !password || !from || (port !== 465 && port !== 587)) return null;
  if (!FROM_RE.test(from)) return null;
  const to = internalRecipients(env);
  if (!to.length || !to.every((r) => EMAIL_RE.test(r))) return null;
  if (/[\x00-\x1f\x7f]/.test(host + user)) return null;
  return { smtp: { host, port, user, password }, from };
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
  const problems: string[] = [];
  for (const name of ['MAIL_SMTP_HOST', 'MAIL_SMTP_USER', 'MAIL_SMTP_PASSWORD', 'MAIL_FROM', 'WAITLIST_NOTIFY_TO']) {
    if (!value(env, name)) problems.push(`${name} (falta)`);
  }
  const port = value(env, 'MAIL_SMTP_PORT');
  if (!port) problems.push('MAIL_SMTP_PORT (falta)');
  else if (port !== '587' && port !== '465') problems.push('MAIL_SMTP_PORT (solo 587 o 465)');
  if (value(env, 'MAIL_FROM') && !FROM_RE.test(value(env, 'MAIL_FROM'))) problems.push('MAIL_FROM (formato: "Nombre <direccion@dominio>")');
  const to = internalRecipients(env);
  if (to.length && !to.every((r) => EMAIL_RE.test(r))) problems.push('WAITLIST_NOTIFY_TO (direcciones no válidas)');
  if (problems.length) {
    throw new InvalidMailConfigError(`WAITLIST_NOTIFY_ENABLED=true pero la configuración de correo no es válida: ${problems.join(', ')}`);
  }
}
