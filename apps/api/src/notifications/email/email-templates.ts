import { EmailGroup } from './notification-email.config';

/**
 * Plantillas de los avisos por email. Reglas (spec «Notificaciones por email» §4.1–4.2, N0-10):
 *  - La PLANTILLA fija el grupo (STAFF_* / PATIENT_*) y con él qué interruptor debe estar encendido.
 *    Remitente único para todos: MAIL_FROM (decisión del Jefe 07/11/2026). Quien encola no lo elige.
 *  - El texto es FIJO. Nunca se usa el title/body de la Notification, su metadata ni ningún texto
 *    libre del equipo (motivo de rechazo, notas…). Al equipo, solo el nombre del espacio.
 *  - Sin nombre ni iniciales del paciente, sin fecha u hora de la cita, sin título de tarea.
 *  - Enlaces fijos, sin ids, tokens ni parámetros. Sin imágenes ni seguimiento.
 */

export const STAFF_TEMPLATES = ['STAFF_APPOINTMENT_REQUEST', 'STAFF_PATIENT_CANCELLATION', 'STAFF_TASK_SUBMITTED'] as const;
export const PATIENT_TEMPLATES = [
  'PATIENT_APPOINTMENT_REMINDER',
  'PATIENT_REQUEST_ACCEPTED',
  'PATIENT_REQUEST_REJECTED',
  'PATIENT_APPOINTMENT_CHANGED',
  'PATIENT_APPOINTMENT_CANCELLED',
] as const;
export type StaffTemplate = (typeof STAFF_TEMPLATES)[number];
export type PatientTemplate = (typeof PATIENT_TEMPLATES)[number];
export type EmailTemplateName = StaffTemplate | PatientTemplate;

export function templateGroup(template: EmailTemplateName): EmailGroup {
  if ((STAFF_TEMPLATES as readonly string[]).includes(template)) return 'STAFF';
  if ((PATIENT_TEMPLATES as readonly string[]).includes(template)) return 'PATIENT';
  throw new Error('Plantilla de email desconocida');
}

export function templatesOf(group: EmailGroup): readonly EmailTemplateName[] {
  return group === 'STAFF' ? STAFF_TEMPLATES : PATIENT_TEMPLATES;
}

export type RenderedEmail = { subject: string; text: string; html: string };

/** Ruta fija de «Mi cuenta → Avisos por email» en la web (la construye Fina en N4 web). */
export const STAFF_EMAIL_SETTINGS_PATH = '/settings/email-notifications';

/**
 * Ruta fija de la web a la que lleva el botón «Entrar en AsePsico» de cada aviso (sin ids ni
 * parámetros). Sin sesión, la web lleva al login y, tras entrar, vuelve a esta ruta.
 *  - Solicitud de cita → bandeja de solicitudes, donde se aceptan o rechazan.
 *  - Tarea entregada → tareas entregadas pendientes de revisar.
 *  - Cancelación → Mi jornada (tarjeta «Cambios en tus citas»).
 * Un email que agrupa avisos de distinto tipo lleva a Mi jornada.
 */
export const STAFF_LINK_PATH: Record<StaffTemplate, string> = {
  STAFF_APPOINTMENT_REQUEST: '/agenda/solicitudes/',
  STAFF_PATIENT_CANCELLATION: '/',
  STAFF_TASK_SUBMITTED: '/follow-up/revisar/',
};

const SINGLE: Record<StaffTemplate, { subject: string; line: (ws: string) => string }> = {
  STAFF_APPOINTMENT_REQUEST: {
    subject: 'Nueva solicitud de cita en AsePsico',
    line: (ws) => `Tienes una solicitud de cita nueva en ${ws}. Entra en AsePsico para verla.`,
  },
  STAFF_PATIENT_CANCELLATION: {
    subject: 'Una cita se ha cancelado en AsePsico',
    line: (ws) => `Un paciente ha cancelado una cita (o retirado una solicitud) en ${ws}. Entra en AsePsico para verlo.`,
  },
  STAFF_TASK_SUBMITTED: {
    subject: 'Tienes una tarea entregada en AsePsico',
    line: (ws) => `Un paciente ha entregado una tarea en ${ws}. Entra en AsePsico para revisarla.`,
  },
};

const COUNT_LABEL: Record<StaffTemplate, [string, string]> = {
  STAFF_APPOINTMENT_REQUEST: ['solicitud de cita nueva', 'solicitudes de cita nuevas'],
  STAFF_PATIENT_CANCELLATION: ['cancelación', 'cancelaciones'],
  STAFF_TASK_SUBMITTED: ['tarea entregada', 'tareas entregadas'],
};

const STAFF_NO_REPLY = 'Es un aviso automático: no respondas a este correo.';
const STAFF_FOOTER = 'Recibes este correo porque tienes activados los avisos por email en AsePsico. Puedes desactivarlos en Mi cuenta.';

/** Nombre del espacio para el texto: una línea, sin caracteres de control, máx. 120 caracteres. */
export function safeWorkspaceName(name: string | null | undefined): string {
  const clean = (name ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || 'tu espacio';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Email al equipo con una o varias entregas del MISMO usuario y espacio (agrupación §4.2). Solo
 * recibe plantillas y nombre del espacio: no hay forma de pasarle datos de un paciente.
 */
export function renderStaffEmail(templates: StaffTemplate[], workspaceName: string, appUrl: string): RenderedEmail {
  if (!templates.length) throw new Error('Sin entregas que enviar');
  const ws = safeWorkspaceName(workspaceName);
  const base = appUrl.replace(/\/+$/, '');
  const kinds = new Set(templates);
  const link = `${base}${kinds.size === 1 ? STAFF_LINK_PATH[templates[0]] : '/'}`;
  const settings = `${base}${STAFF_EMAIL_SETTINGS_PATH}`;
  let subject: string;
  let message: string;
  if (templates.length === 1) {
    subject = SINGLE[templates[0]].subject;
    message = SINGLE[templates[0]].line(ws);
  } else {
    const counts = new Map<StaffTemplate, number>();
    for (const t of templates) counts.set(t, (counts.get(t) ?? 0) + 1);
    const parts = STAFF_TEMPLATES.filter((t) => counts.has(t)).map((t) => {
      const n = counts.get(t)!;
      return `${n} ${COUNT_LABEL[t][n === 1 ? 0 : 1]}`;
    });
    subject = 'Tienes novedades en AsePsico';
    message = `Tienes novedades en ${ws}: ${parts.join(', ')}. Entra en AsePsico para verlas.`;
  }
  const text = `${message}\n\nEntrar en AsePsico: ${link}\n\n--\n${STAFF_NO_REPLY}\n${STAFF_FOOTER}\n${settings}\n`;
  const html = [
    '<!doctype html><html lang="es"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">',
    `<p>${escapeHtml(message)}</p>`,
    `<p><a href="${escapeHtml(link)}">Entrar en AsePsico</a></p>`,
    `<hr><p style="font-size:12px;color:#6b7280">${escapeHtml(STAFF_NO_REPLY)}<br>${escapeHtml(STAFF_FOOTER)} <a href="${escapeHtml(settings)}">Mi cuenta</a></p>`,
    '</body></html>',
  ].join('');
  return { subject, text, html };
}
