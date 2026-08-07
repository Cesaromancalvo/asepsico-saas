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

/**
 * Cliente de la API. Si una petición autenticada devuelve 401 (access token caducado),
 * intenta renovar la sesión una vez vía /auth/refresh y repite la petición original antes
 * de rendirse. Esto evita que el usuario tenga que volver a iniciar sesión cada 15 minutos.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response = await request<T>(path, init);
  if (response.status === 401 && path !== '/auth/login' && path !== '/auth/refresh') {
    const refreshed = await request('/auth/refresh', { method: 'POST' });
    if (refreshed.ok) {
      response = await request<T>(path, init);
    }
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? 'Error de conexión');
  }
  return response.json();
}

export async function logout() {
  await request('/auth/logout', { method: 'POST' });
}
