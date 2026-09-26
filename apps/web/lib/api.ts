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
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

// Rutas en las que un 401 es una respuesta de negocio (credenciales, código, pendingToken) y
// no un access token caducado. Repetirlas tras renovar la sesión contaría el fallo dos veces
// en el límite de intentos del MFA.
const NO_REFRESH_PATHS = new Set(['/auth/login', '/auth/login/mfa', '/auth/refresh']);
// En estas rutas, el 401 puede venir del guard (token caducado) o del servicio (contraseña o
// código incorrectos). Solo se renueva y repite si el 401 es el genérico del guard.
const BUSINESS_401_PATHS = new Set(['/auth/mfa/confirm', '/auth/mfa/disable']);
const AUTH_LAYER_401_MESSAGES = new Set(['Unauthorized', 'Token no válido para este dominio']);

async function readMessage(response: Response): Promise<string | undefined> {
  const body = await response.json().catch(() => ({}));
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('. ');
  return typeof message === 'string' ? message : undefined;
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
    let message = (await readMessage(response)) ?? 'Error de conexión';
    // El límite genérico por IP (Throttler) responde en inglés; el del MFA ya trae su texto.
    if (response.status === 429 && message.startsWith('ThrottlerException')) {
      message = 'Demasiadas peticiones seguidas. Espera un minuto y vuelve a intentarlo.';
    }
    throw new ApiError(message, response.status);
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
