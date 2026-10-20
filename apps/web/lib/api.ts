const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<Response> {
  const csrfToken = readCookie('csrf_token');
  const isMutation = !!init.method && init.method.toUpperCase() !== 'GET';
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include', // envía/recibe las cookies httpOnly de sesión
    headers: {
      'Content-Type': 'application/json',
      ...(isMutation && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...init.headers,
    },
  });
}

/** Error de la API con el código HTTP, para que las pantallas distingan 401, 429, 400… */
export class ApiError extends Error {
  /** Cuerpo JSON de la respuesta de error (p. ej. `code` y `sessions` del 409 al cerrar un proceso). */
  body: Record<string, unknown> = {};

  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Código estable de la API (p. ej. REGISTRATION_NOT_ALLOWED) o undefined. */
export function apiErrorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}

/** Pantalla a la que lleva el 428 TERMS_ACCEPTANCE_REQUIRED (condiciones nuevas sin aceptar). */
export const TERMS_PAGE = '/terms';

/**
 * Interceptor global del 428: la API bloquea a cada profesional (titular o miembro) hasta que
 * acepte las condiciones nuevas. Cualquier pantalla que lo reciba lleva a la de "Nuevas
 * condiciones" (salvo si ya está en ella). Solo se redirige una vez aunque lleguen varios 428 a la
 * vez (las pantallas lanzan varias peticiones en paralelo).
 */
let redirectingToTerms = false;

function redirectToTermsIfRequired(status: number, code: string | undefined) {
  if (status !== 428 || code !== 'TERMS_ACCEPTANCE_REQUIRED' || typeof window === 'undefined') return;
  if (window.location.pathname === TERMS_PAGE || redirectingToTerms) return;
  redirectingToTerms = true;
  window.location.assign(TERMS_PAGE);
}

/** Código del 401 de la API cuando el token está bien firmado pero la sesión ya no vale (baja del equipo, contraseña cambiada). */
export const SESSION_REVOKED = 'SESSION_REVOKED';
/** Login con el aviso de sesión terminada (la pantalla de login lo lee de la URL). */
export const SESSION_REVOKED_LOGIN_URL = '/login?sesion=terminada';

/**
 * Interceptor global del 401 SESSION_REVOKED. Llega aquí solo cuando ya se intentó renovar la
 * sesión una vez (o la renovación falló, o la petición repetida sigue rechazada): no hay más
 * reintentos y se va al login con un aviso. Una sola redirección aunque fallen varias peticiones
 * en paralelo, y nunca desde el propio login (sin bucles).
 */
let redirectingToLogin = false;

function redirectToLoginIfRevoked(status: number, code: string | undefined) {
  if (status !== 401 || code !== SESSION_REVOKED || typeof window === 'undefined') return;
  if (window.location.pathname === '/login' || redirectingToLogin) return;
  redirectingToLogin = true;
  window.location.assign(SESSION_REVOKED_LOGIN_URL);
}

/** Solo para tests: vuelve a permitir la redirección. */
export function resetSessionRedirectForTests() {
  redirectingToLogin = false;
  redirectingToTerms = false;
}

// Rutas en las que un 401 es una respuesta de negocio (credenciales, código, pendingToken) y
// no un access token caducado. Repetirlas tras renovar la sesión contaría el fallo dos veces
// en el límite de intentos del MFA.
const NO_REFRESH_PATHS = new Set(['/auth/login', '/auth/login/mfa', '/auth/refresh']);
// En estas rutas, el 401 puede venir del guard (token caducado) o del servicio (contraseña o
// código incorrectos). Solo se renueva y repite si el 401 es el genérico del guard.
export const BUSINESS_401_PATHS: ReadonlySet<string> = new Set(['/auth/mfa/confirm', '/auth/mfa/disable', '/auth/change-password']);
const AUTH_LAYER_401_MESSAGES = new Set(['Unauthorized', 'Token no válido para este dominio']);

async function readError(response: Response): Promise<{ message?: string; code?: string }> {
  const body = (await response.json().catch(() => ({}))) as { message?: unknown; code?: unknown };
  const code = typeof body.code === 'string' ? body.code : undefined;
  if (Array.isArray(body.message)) return { message: body.message.join('. '), code };
  return { message: typeof body.message === 'string' ? body.message : undefined, code };
}

async function readMessage(response: Response): Promise<string | undefined> {
  return (await readError(response)).message;
}

async function shouldRefresh(path: string, response: Response): Promise<boolean> {
  if (response.status !== 401 || NO_REFRESH_PATHS.has(path)) return false;
  if (!BUSINESS_401_PATHS.has(path)) return true;
  const message = await readMessage(response.clone());
  return message === undefined || AUTH_LAYER_401_MESSAGES.has(message);
}

/**
 * Cliente de la API. Si una petición autenticada devuelve 401 (access token caducado),
 * intenta renovar la sesión una vez vía /auth/refresh y repite la petición original antes
 * de rendirse. Esto evita que el usuario tenga que volver a iniciar sesión cada 15 minutos.
 * Si tras ese único intento la respuesta sigue siendo 401 SESSION_REVOKED (baja del equipo o
 * contraseña cambiada), se lleva al login con un aviso.
 * Los errores se lanzan como ApiError (con `status`).
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response = await request<T>(path, init);
  if (await shouldRefresh(path, response)) {
    const refreshed = await request('/auth/refresh', { method: 'POST' });
    if (refreshed.ok) {
      response = await request<T>(path, init);
    }
  }
  if (!response.ok) {
    const body = (await response.clone().json().catch(() => ({}))) as Record<string, unknown>;
    const { message: apiMessage, code } = await readError(response);
    let message = apiMessage ?? 'Error de conexión';
    // El límite genérico por IP (Throttler) responde en inglés; el del MFA ya trae su texto.
    if (response.status === 429 && message.startsWith('ThrottlerException')) {
      message = 'Demasiadas peticiones seguidas. Espera un minuto y vuelve a intentarlo.';
    }
    redirectToTermsIfRequired(response.status, code);
    if (!NO_REFRESH_PATHS.has(path)) redirectToLoginIfRevoked(response.status, code);
    const error = new ApiError(message, response.status, code);
    error.body = body && typeof body === 'object' ? body : {};
    throw error;
  }
  return response.json();
}

/**
 * Renueva la sesión para que el access token refleje cambios de la cuenta (p. ej. el MFA
 * recién activado). Devuelve false si no se pudo; no lanza.
 */
export async function refreshSession(): Promise<boolean> {
  try {
    return (await request('/auth/refresh', { method: 'POST' })).ok;
  } catch {
    return false;
  }
}

export async function logout() {
  await request('/auth/logout', { method: 'POST' });
}
