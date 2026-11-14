/*
 * Volver a donde ibas después de iniciar sesión (`/login?next=/ruta`).
 *
 * Caso real: el email al equipo «Nueva solicitud de cita» lleva a una pantalla del área
 * profesional. Si no hay sesión (o ha caducado), la API responde 401: se lleva al login con el
 * destino en `next` y, tras el login (MFA incluido) o tras aceptar las condiciones nuevas
 * (`/terms?next=…`), se vuelve a ese destino.
 *
 * Seguridad (lo revisa Argos): `next` llega en la URL y lo controla cualquiera que mande un enlace.
 * Solo se acepta una RUTA INTERNA relativa a la raíz de la app:
 *  - empieza por una sola `/` (nada de `//host`, `/\host`, `https:`, `javascript:`, `data:`…);
 *  - sin espacios, tabuladores, saltos de línea ni otros caracteres de control (el parser de URL
 *    se los salta y `/\t/host` acabaría siendo `//host`);
 *  - sin `\` (los navegadores la tratan como `/`) ni sus formas codificadas `%5C`, ni `%2F`/`%09`…
 *    al principio que pudieran reinterpretarse como `//`;
 *  - solo caracteres de URL «normales» (lista cerrada) y como mucho 512 caracteres;
 *  - y, como red de seguridad, resuelta contra un origen ficticio tiene que seguir en ese origen.
 * Además no se vuelve a pantallas públicas o de otro circuito (login, alta, portal del paciente):
 * ahí no tiene sentido y evita bucles. Si algo no cuadra, se ignora y se usa el destino por defecto.
 */

const MAX_NEXT_LENGTH = 512;
/** Caracteres permitidos en ruta + query + ancla (RFC 3986 sin espacios ni `\`, `<`, `>`, `"`, `` ` ``, `{`, `}`, `|`, `^`). */
const SAFE_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%?#]*$/;
const PROBE_ORIGIN = 'https://next.invalid';

/** Pantallas a las que nunca se vuelve tras el login del personal (y donde un 401 no lleva al login). */
const PUBLIC_PREFIXES = ['/login', '/register', '/join', '/legal', '/portal'] as const;

/**
 * Panel oculto de plataforma (`/admin/…`): sin sesión debe seguir mostrando el 404 normal, sin
 * pistas de que existe (decisión de Argos). Ni se redirige al login desde ahí ni se vuelve a él.
 */
const HIDDEN_PREFIXES = ['/admin'] as const;

function matches(pathname: string, prefixes: readonly string[]): boolean {
  const path = pathname.split(/[?#]/)[0] || '/';
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** `true` si la ruta es de una pantalla pública o del portal del paciente (no del área profesional). */
export function isPublicPath(pathname: string): boolean {
  return matches(pathname, PUBLIC_PREFIXES);
}

/** `true` si en esta pantalla un 401 NO debe llevar al login (públicas, portal y panel oculto). */
export function skipsLoginRedirect(pathname: string): boolean {
  return matches(pathname, PUBLIC_PREFIXES) || matches(pathname, HIDDEN_PREFIXES);
}

/**
 * Devuelve `next` si es una ruta interna segura del área profesional; si no, `null`.
 * Acepta el valor tal cual sale de `URLSearchParams.get` (ya decodificado una vez).
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw || raw.length > MAX_NEXT_LENGTH) return null;
  if (!SAFE_CHARS.test(raw)) return null; // también descarta \ , espacios y caracteres de control
  if (raw[0] !== '/' || raw[1] === '/') return null; // solo ruta absoluta de la propia app, nunca //host
  // Formas codificadas que algún servidor o navegador podría reinterpretar como separadores.
  if (/%(5c|2f|09|0a|0d|00)/i.test(raw.slice(0, 4)) || /%5c/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return null;
  if (skipsLoginRedirect(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** URL del login que, tras entrar, vuelve a `next` (si es seguro). */
export function loginHref(next?: string | null): string {
  const safe = safeNextPath(next);
  return safe ? `/login?next=${encodeURIComponent(safe)}` : '/login';
}

/** Igual que `loginHref` pero con el aviso de «sesión terminada» (401 SESSION_REVOKED). */
export function sessionEndedLoginHref(next?: string | null): string {
  const safe = safeNextPath(next);
  return safe ? `/login?sesion=terminada&next=${encodeURIComponent(safe)}` : '/login?sesion=terminada';
}

/** Pantalla de condiciones nuevas (428) que, tras aceptarlas, vuelve a `next` (si es seguro). */
export function termsHref(termsPage: string, next?: string | null): string {
  const safe = safeNextPath(next);
  return safe && safe !== termsPage && !safe.startsWith(`${termsPage}?`) && !safe.startsWith(`${termsPage}/`)
    ? `${termsPage}?next=${encodeURIComponent(safe)}`
    : termsPage;
}

/** Ruta actual (ruta + query) para usarla como `next`. Vacía fuera del navegador. */
export function currentPath(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search ?? ''}`;
}

/** Lee `next` de la query actual y lo valida. `null` si no hay o no es seguro. */
export function nextFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return safeNextPath(new URLSearchParams(window.location.search).get('next'));
}
