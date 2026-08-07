import { Response } from 'express';
import { randomBytes } from 'crypto';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const CSRF_COOKIE = 'csrf_token';

const isProd = process.env.NODE_ENV === 'production';

function baseOptions() {
  return {
    secure: isProd,
    sameSite: 'lax' as const,
    domain: process.env.COOKIE_DOMAIN || undefined,
  };
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
    ...baseOptions(),
    httpOnly: false,
    path: '/',
    maxAge: 15 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response) {
  const opts = baseOptions();
  res.clearCookie(ACCESS_COOKIE, { ...opts, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...opts, path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE, { ...opts, path: '/' });
}
