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

/*
 * Migración a sesión host-only: antes de la salida de Vercel, access_token y refresh_token se
 * emitían con Domain=COOKIE_DOMAIN (.asepsico.es). Esas cookies antiguas siguen en el navegador
 * hasta 7 días y se envían JUNTO a las nuevas host-only; cookie-parser se queda con la antigua
 * (ya revocada), auth.service lo toma como reutilización del refresh token, revoca la familia y
 * responde 401. Por eso, cada vez que se emiten o se borran las cookies de sesión, se borran
 * también las antiguas con su mismo ámbito (domain + path). Sin COOKIE_DOMAIN no hay nada que
 * limpiar. Las cookies se identifican por nombre, dominio y ruta: borrar la de Domain no toca la
 * host-only nueva.
 */
function clearLegacyDomainSessionCookies(res: Response) {
  const domain = process.env.COOKIE_DOMAIN;
  if (!domain) return;
  res.clearCookie(ACCESS_COOKIE, { ...baseOptions(), domain, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(), domain, path: '/api/v1/auth' });
}

export function setAuthCookies(res: Response, params: { accessToken: string; refreshToken: string; refreshTokenExpiresAt: Date }) {
  clearLegacyDomainSessionCookies(res);
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
  clearLegacyDomainSessionCookies(res);
  res.clearCookie(ACCESS_COOKIE, { ...opts, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...opts, path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE, { ...csrfOptions(), path: '/' });
}
