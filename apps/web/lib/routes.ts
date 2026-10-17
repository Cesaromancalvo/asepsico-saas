/*
 * Rutas de la app con id en query string.
 *
 * La web se publica como sitio estático (`output: 'export'`): no hay servidor que resuelva
 * `/patients/<uuid>`, y los ids son UUID de la BD, imposibles de pregenerar. Por eso las fichas,
 * procesos y sesiones viven en rutas fijas (`/patients/view/`, `/agenda/session/`) y el id va en
 * la query. Toda URL de esas pantallas se construye aquí.
 *
 * Privacidad: el id es un UUID opaco, no un dato clínico (igual que antes en la ruta). La
 * cabecera Referrer-Policy del hosting evita que la query salga a terceros.
 *
 * La barra final es intencionada: `trailingSlash: true` genera `ruta/index.html`.
 */

export const PATIENT_SECTIONS = ['assessments', 'documents', 'plan', 'portal', 'resources', 'tasks'] as const;
export type PatientSection = (typeof PATIENT_SECTIONS)[number];

const q = encodeURIComponent;

export function patientHref(patientId: string, section?: PatientSection): string {
  return `/patients/view/${section ? `${section}/` : ''}?id=${q(patientId)}`;
}

export function processHref(patientId: string, processId: string): string {
  return `/patients/view/process/?id=${q(patientId)}&processId=${q(processId)}`;
}

export function sessionHref(sessionId: string): string {
  return `/agenda/session/?id=${q(sessionId)}`;
}

// Segmento de id antiguo: cualquier cosa sin "/" que no sea una ruta fija de la app.
const ID = '([^/?#]+)';
const RESERVED = new Set(['view', 'session']);

/**
 * Traduce una URL con el formato antiguo (`/patients/<id>/plan`, `/agenda/<id>`...) al nuevo.
 * Devuelve null si no es una URL antigua. La usan los enlaces que genera la API (línea temporal,
 * tareas del panel) y la página 404, para que marcadores y enlaces viejos sigan funcionando.
 */
export function legacyToStatic(href: string): string | null {
  try {
    return translateLegacy(href);
  } catch {
    return null; // %-codificación inválida en la URL: se trata como no antigua
  }
}

function translateLegacy(href: string): string | null {
  const cut = href.search(/[?#]/);
  const path = cut < 0 ? href : href.slice(0, cut);
  const rest = cut < 0 ? '' : href.slice(cut);
  const clean = path.replace(/\/+$/, '');
  let m = clean.match(new RegExp(`^/agenda/${ID}$`));
  if (m && !RESERVED.has(m[1])) return sessionHref(decodeURIComponent(m[1])) + carry(rest);
  m = clean.match(new RegExp(`^/patients/${ID}/processes/${ID}$`));
  if (m && !RESERVED.has(m[1])) return processHref(decodeURIComponent(m[1]), decodeURIComponent(m[2])) + carry(rest);
  m = clean.match(new RegExp(`^/patients/${ID}(?:/([a-z]+))?$`));
  if (m && !RESERVED.has(m[1])) {
    const section = m[2] as PatientSection | undefined;
    if (section && !PATIENT_SECTIONS.includes(section)) return null;
    return patientHref(decodeURIComponent(m[1]), section) + carry(rest);
  }
  return null;
}

/** URL lista para un <Link>: traduce las antiguas y deja el resto igual. */
export function appHref(href: string): string {
  return legacyToStatic(href) ?? href;
}

// Conserva la query/ancla original (sin "?" porque el destino ya tiene uno).
function carry(rest: string): string {
  if (!rest) return '';
  return rest.startsWith('?') ? `&${rest.slice(1)}` : rest;
}
