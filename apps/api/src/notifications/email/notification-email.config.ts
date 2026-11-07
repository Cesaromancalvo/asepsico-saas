import { isValidFrom, readSmtpConfig, smtpConfigProblems, SmtpConfig } from '../../mail/mail.config';

/**
 * Configuración de los avisos por email (bandeja de salida sobre NotificationDelivery).
 *
 * Interruptores de emergencia INDEPENDIENTES (los gestiona Dora; ningún valor en el repo):
 *   STAFF_EMAIL_NOTIFICATIONS_ENABLED    avisos al equipo (N1–N3). Distinto de "true" → no sale nada.
 *   PATIENT_EMAIL_NOTIFICATIONS_ENABLED  avisos a pacientes (P1–P3). Distinto de "true" → no sale nada.
 * Con un grupo apagado sus entregas se quedan PENDING hasta caducar (nunca sale un aviso viejo).
 *
 * Listas blancas de espacios (ids separados por comas):
 *   PATIENT_EMAIL_WORKSPACE_ALLOWLIST  OBLIGATORIA para pacientes: vacía = ningún espacio envía a
 *                                      pacientes aunque el interruptor esté en true (P-SEG-2).
 *   STAFF_EMAIL_WORKSPACE_ALLOWLIST    opcional para el equipo: vacía = todos los espacios.
 *
 * Remitente ÚNICO (decisión del Jefe 07/11/2026, sustituye a la D1 del dominio neutro): todos los
 * emails, al equipo y a pacientes, salen de MAIL_FROM («AsePsico <avisos@notificaciones.asepsico.es>»).
 * Nadie que encole un email puede elegir otro remitente.
 *
 * APP_PUBLIC_URL  base de los enlaces fijos del email al equipo (por defecto https://app.asepsico.es).
 */

export type EmailGroup = 'STAFF' | 'PATIENT';

export type NotificationEmailConfig = {
  smtp: SmtpConfig | null;
  /** Remitente único (MAIL_FROM) si es válido; null si no (entonces no se envía nada). */
  from: string | null;
  staff: { enabled: boolean; allowlist: Set<string> | null };
  patient: { enabled: boolean; allowlist: Set<string> };
  appUrl: string;
};

export class InvalidNotificationEmailConfigError extends Error {}

const DEFAULT_APP_URL = 'https://app.asepsico.es';

const value = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? '').trim();
const flag = (env: NodeJS.ProcessEnv, name: string) => value(env, name).toLowerCase() === 'true';
const idList = (raw: string) => new Set(raw.split(',').map((id) => id.trim()).filter(Boolean));

/** Problemas de la configuración común a los dos grupos, solo con NOMBRES de variables. */
export function notificationEmailProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems = smtpConfigProblems(env);
  const from = env.MAIL_FROM ?? '';
  if (!from.trim()) problems.push('MAIL_FROM (falta)');
  else if (!isValidFrom(from)) problems.push('MAIL_FROM (formato: "Nombre <direccion@dominio>")');
  if (value(env, 'APP_PUBLIC_URL') && !/^https:\/\/[^\s/?#]+$/.test(value(env, 'APP_PUBLIC_URL'))) problems.push('APP_PUBLIC_URL (solo https://host, sin ruta)');
  return problems;
}

export function readNotificationEmailConfig(env: NodeJS.ProcessEnv = process.env): NotificationEmailConfig {
  const ok = notificationEmailProblems(env).length === 0;
  const staffAllow = idList(value(env, 'STAFF_EMAIL_WORKSPACE_ALLOWLIST'));
  return {
    smtp: readSmtpConfig(env),
    from: ok ? env.MAIL_FROM ?? null : null,
    // Un grupo solo está encendido si su interruptor es "true" Y la configuración es válida.
    staff: { enabled: flag(env, 'STAFF_EMAIL_NOTIFICATIONS_ENABLED') && ok, allowlist: staffAllow.size ? staffAllow : null },
    patient: { enabled: flag(env, 'PATIENT_EMAIL_NOTIFICATIONS_ENABLED') && ok, allowlist: idList(value(env, 'PATIENT_EMAIL_WORKSPACE_ALLOWLIST')) },
    appUrl: value(env, 'APP_PUBLIC_URL') || DEFAULT_APP_URL,
  };
}

/** ¿Puede este grupo enviar en este espacio ahora? (interruptor + configuración + lista blanca). */
export function groupEnabledFor(config: NotificationEmailConfig, group: EmailGroup, workspaceId: string): boolean {
  if (!config.smtp || !config.from) return false;
  if (group === 'STAFF') return config.staff.enabled && (!config.staff.allowlist || config.staff.allowlist.has(workspaceId));
  return config.patient.enabled && config.patient.allowlist.has(workspaceId);
}

/**
 * Al arrancar (main.ts): con un interruptor en true y la configuración de su grupo incompleta, la
 * API no arranca (error con NOMBRES de variables, nunca valores). Apagados, no se exige nada.
 */
export function assertNotificationEmailConfig(env: NodeJS.ProcessEnv = process.env): void {
  const on = flag(env, 'STAFF_EMAIL_NOTIFICATIONS_ENABLED') || flag(env, 'PATIENT_EMAIL_NOTIFICATIONS_ENABLED');
  const problems = on ? notificationEmailProblems(env) : [];
  if (problems.length) {
    throw new InvalidNotificationEmailConfigError(`Avisos por email encendidos pero la configuración no es válida: ${[...new Set(problems)].join(', ')}`);
  }
}
