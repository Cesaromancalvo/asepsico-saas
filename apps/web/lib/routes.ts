/*
 * Rutas de la app con id en query string.
 *
 * La web se publica como sitio estático (`output: 'export'`): no hay servidor que resuelva
 * `/patients/<id>`, y los ids de la BD (cuid) no se pueden pregenerar. Por eso las fichas,
 * procesos y sesiones viven en rutas fijas (`/patients/view/`, `/agenda/session/`) y el id va en
 * la query. Toda URL de esas pantallas se construye aquí.
 *
 * Seguridad (condición de Argos): un id leído de la URL se interpola después en rutas de la API
 * (`/patients/${id}/…`). Solo se acepta con forma de cuid (`queryId`): así no puede colarse `/`,
 * `..`, `?`, `%2F` ni `//host` y redirigir la llamada a otro endpoint.
 *
 * Privacidad: el id es opaco, no un dato clínico (igual que antes en la ruta). El Static Site
 * envía `Referrer-Policy: no-referrer`, así que la query no sale a terceros.
 *
 * La barra final es intencionada: `trailingSlash: true` genera `ruta/index.html`.
 */

export const PATIENT_SECTIONS = ['assessments', 'documents', 'plan', 'portal', 'resources', 'tasks'] as const;
export type PatientSection = (typeof PATIENT_SECTIONS)[number];

/** Forma de los ids de la BD (Prisma `@default(cuid())`). */
const CUID = /^[a-z0-9]{20,40}$/;

/** Devuelve el id si tiene forma de cuid; si no (o es null), cadena vacía. */
export function queryId(value: string | null | undefined): string {
  return typeof value === 'string' && CUID.test(value) ? value : '';
}

const q = encodeURIComponent;

export function patientHref(patientId: string, section?: PatientSection): string {
  return `/patients/view/${section ? `${section}/` : ''}?id=${q(patientId)}`;
}

/** Valor de `?filtro=` que abre las tareas de un paciente en «Por revisar» (entregadas). */
export const TASKS_TO_REVIEW_FILTER = 'por-revisar';

/** Tareas entregadas de un paciente, con el filtro «Por revisar» ya puesto. */
export function patientTasksToReviewHref(patientId: string): string {
  return `${patientHref(patientId, 'tasks')}&filtro=${TASKS_TO_REVIEW_FILTER}`;
}

/** Pantalla con todas las tareas entregadas pendientes de revisar (de varios pacientes). */
export const TASKS_TO_REVIEW_PAGE = '/follow-up/revisar/';

/**
 * Destino de la tarjeta «Tareas por revisar» de Mi jornada: con un solo paciente, sus tareas en
 * «Por revisar»; con varios (o ninguno), la lista de tareas entregadas.
 * `patientIds` sale de los avisos TASK_REVIEW del panel (ver taskReviewPatientId).
 */
export function tasksToReviewHref(patientIds: string[]): string {
  const unique = Array.from(new Set(patientIds.map(queryId).filter(Boolean)));
  return unique.length === 1 ? patientTasksToReviewHref(unique[0]) : TASKS_TO_REVIEW_PAGE;
}

/** Id del paciente de un aviso «Revisar tarea» (href antiguo `/patients/<id>/tasks`), o ''. */
export function taskReviewPatientId(href: string): string {
  const match = /^\/patients\/([^/?#]+)\/tasks(?:[/?#]|$)/.exec(href);
  return match ? queryId(match[1]) : '';
}

export function processHref(patientId: string, processId: string): string {
  return `/patients/view/process/?id=${q(patientId)}&processId=${q(processId)}`;
}

export function sessionHref(sessionId: string): string {
  return `/agenda/session/?id=${q(sessionId)}`;
}

/**
 * Traduce una URL con el formato antiguo (`/patients/<id>/plan`, `/agenda/<id>`...) al nuevo.
 * Devuelve null si no es una URL antigua válida. La usan los enlaces que genera la API (línea
 * temporal, panel) y la página 404, para que marcadores y enlaces viejos sigan funcionando.
 * Garantía: el resultado, si no es null, siempre empieza por `/patients/view/` o `/agenda/session/`.
 * La query/ancla original no se arrastra: solo viajan ids validados.
 */
export function legacyToStatic(href: string): string | null {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return null;
  const cut = href.search(/[?#]/);
  const segments = (cut < 0 ? href : href.slice(0, cut)).split('/').filter(Boolean);

  if (segments[0] === 'agenda' && segments.length === 2) {
    const id = queryId(segments[1]);
    return id ? sessionHref(id) : null;
  }
  if (segments[0] !== 'patients') return null;
  const patientId = queryId(segments[1]);
  if (!patientId) return null;
  if (segments.length === 2) return patientHref(patientId);
  if (segments.length === 3) {
    const section = segments[2] as PatientSection;
    return PATIENT_SECTIONS.includes(section) ? patientHref(patientId, section) : null;
  }
  if (segments.length === 4 && segments[2] === 'processes') {
    const processId = queryId(segments[3]);
    return processId ? processHref(patientId, processId) : null;
  }
  return null;
}

/** URL lista para un <Link>: traduce las antiguas y deja el resto igual. */
export function appHref(href: string): string {
  return legacyToStatic(href) ?? href;
}
