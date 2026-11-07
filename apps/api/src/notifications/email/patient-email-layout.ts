import { DEFAULT_TIME_ZONE, isValidTimeZone } from '../../scheduling/time-zone.util';
import { PatientTemplate, RenderedEmail } from './email-templates';

/**
 * Molde COMÚN de los emails a pacientes (P1–P3, aún apagados). Aplica las mitigaciones de Lex
 * (07/11 tarde) por el remitente identificable:
 *  - M1 · Nombre visible neutro: el del espacio, por defecto «Avisos de cita»; nunca «AsePsico» ni
 *    nada con «psico», «terapia», «salud», «clínica»… (si lo lleva, se usa el defecto).
 *  - M2 · Asunto neutro: prefijo fijo + SOLO fecha y hora (es lo que queda en los logs del proveedor).
 *  - M3 · Primera línea y vista previa neutras (lo que se ve en la notificación del móvil): sin
 *    AsePsico ni psicología. Sin logo ni imágenes. AsePsico solo se nombra en el pie.
 *  - M6 · Sin seguimiento: ni píxeles, ni imágenes remotas, ni enlaces con parámetros.
 * Las plantillas P1–P3 que se construyan encima solo aportan las líneas del cuerpo (texto fijo).
 */

export const DEFAULT_PATIENT_SENDER_NAME = 'Avisos de cita';

/** Palabras que nunca pueden ir en el nombre visible, el asunto ni la primera línea (M1–M3). */
export const NON_NEUTRAL_WORDS = /asepsico|psico|psicol|psych|terap|therap|salud|mental|cl[ií]nic|sanitari|sesi[oó]n/i;

const SUBJECT_PREFIX: Record<PatientTemplate, string> = {
  PATIENT_APPOINTMENT_REMINDER: 'Recordatorio de cita',
  PATIENT_REQUEST_ACCEPTED: 'Cita confirmada',
  PATIENT_REQUEST_REJECTED: 'Respuesta a tu solicitud de cita',
  PATIENT_APPOINTMENT_CHANGED: 'Tu cita ha cambiado',
  PATIENT_APPOINTMENT_CANCELLED: 'Cita cancelada',
};

const PATIENT_FOOTER = [
  'Correo automático: no respondas a él. Si no quieres recibir estos avisos, desactívalos en tu portal o díselo a tu consulta.',
  'Aviso enviado a través de AsePsico, la herramienta de gestión de tu consulta.',
];

/** Nombre visible del remitente de pacientes (M1): una línea, sin < > " ni control, máx. 60, neutro. */
export function patientSenderName(name: string | null | undefined): string {
  const clean = (name ?? '').replace(/[\x00-\x1f\x7f<>"\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean && !NON_NEUTRAL_WORDS.test(clean) ? clean : DEFAULT_PATIENT_SENDER_NAME;
}

/** «martes 10 de noviembre, 10:00» en la zona del espacio. */
export function patientDateLabel(date: Date, timeZone: string): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.weekday} ${parts.day} de ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/** Asunto M2: prefijo fijo de la plantilla + solo fecha y hora (P2b no lleva fecha). */
export function patientSubject(template: PatientTemplate, startsAt: Date | null, timeZone: string): string {
  const prefix = SUBJECT_PREFIX[template];
  return template === 'PATIENT_REQUEST_REJECTED' || !startsAt ? prefix : `${prefix}: ${patientDateLabel(startsAt, timeZone)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Compone el email. `lines[0]` es la primera línea (vista previa): debe ser neutra (M3) o lanza.
 * `portalUrl` opcional: enlace FIJO a la entrada del portal, sin parámetros (si no, se omite).
 */
export function renderPatientEmail(params: {
  template: PatientTemplate;
  startsAt: Date | null;
  timeZone: string;
  greeting: string;
  lines: string[];
  portalUrl?: string | null;
}): RenderedEmail {
  const subject = patientSubject(params.template, params.startsAt, params.timeZone);
  const [first, ...rest] = params.lines;
  if (!first) throw new Error('Falta la primera línea');
  for (const text of [subject, params.greeting, first]) {
    if (NON_NEUTRAL_WORDS.test(text) || /[\r\n]/.test(text)) throw new Error('Texto no neutro en asunto, saludo o primera línea');
  }
  const link = params.portalUrl && /^https:\/\/[^\s?#]+$/.test(params.portalUrl) ? params.portalUrl : null;
  // La primera línea va antes del saludo: es lo que muestra la vista previa del cliente de correo.
  const body = [first, '', params.greeting, ...rest, ...(link ? ['', `Tu portal: ${link}`] : [])];
  const text = `${body.join('\n')}\n\n--\n${PATIENT_FOOTER.join('\n')}\n`;
  const html = [
    '<!doctype html><html lang="es"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">',
    ...[first, params.greeting, ...rest].map((line) => `<p>${escapeHtml(line)}</p>`),
    link ? `<p><a href="${escapeHtml(link)}">Tu portal</a></p>` : '',
    `<hr><p style="font-size:12px;color:#6b7280">${PATIENT_FOOTER.map(escapeHtml).join('<br>')}</p>`,
    '</body></html>',
  ].join('');
  return { subject, text, html };
}
