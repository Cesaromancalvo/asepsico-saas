import { Response } from 'express';
import { randomBytes } from 'crypto';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const CSRF_COOKIE = 'csrf_token';

const isProd = process.env.NODE_ENV === 'production';

/*
 * Sesión (access_token, refresh_token): host-only, sin Domain. Solo las recibe el host de la API
 * (api.asepsico.es); un subdominio comprometido o la propia web no las ven ni las reciben.
 * csrf_token: con COOKIE_DOMAIN (p. ej. .asepsico.es) porque la web (app.) tiene que leerlo con
 * document.cookie para reenviarlo en x-csrf-token. No da acceso por sí solo.
 */
function baseOptions() {
  return {
    secure: isProd,
    sameSite: 'lax' as const,
  };
}

function csrfOptions() {
  return { ...baseOptions(), domain: process.env.COOKIE_DOMAIN || undefined };
}

export function setAuthCookies(res: Response, params: { accessToken: string; refreshToken: string; refreshTokenExpiresAt: Date }) {
  res.cookie(ACCESS_COOKIE, params.accessToken, {
    ...baseOptions(),
    httpOnly: true,
    path: '/',
    maxAge: 15 * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, params.refreshToken, {
    ...baseOptions(),
    httpOnly: true,
    path: '/api/v1/auth',
    expires: params.refreshTokenExpiresAt,
  });
  // El token CSRF NO es httpOnly: el frontend debe poder leerlo y reenviarlo como header
  // en cada petición que modifique estado (patrón "double submit cookie").
  const csrfToken = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE, csrfToken, {
    ...csrfOptions(),
    httpOnly: false,
    path: '/',
    maxAge: 15 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response) {
  const opts = baseOptions();
  res.clearCookie(ACCESS_COOKIE, { ...opts, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...opts, path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE, { ...csrfOptions(), path: '/' });
}
