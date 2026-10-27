#!/usr/bin/env node
/*
 * Comprobación del sitio estático de la app (Render Static Site) y del CORS de la API.
 * Solo hace peticiones GET/HEAD/OPTIONS públicas: no inicia sesión, no envía datos ni secretos.
 *
 *   node scripts/verify-static-site.mjs                       # app.asepsico.es + api.asepsico.es
 *   node scripts/verify-static-site.mjs --antes-del-corte     # Día 1: aún no se exige CORS para app.
 *   node scripts/verify-static-site.mjs --app https://asepsico-app.onrender.com --api https://api.asepsico.es/api/v1
 *
 * Termina con código 1 si falla alguna comprobación.
 */
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const APP = opt('app', 'https://app.asepsico.es').replace(/\/+$/, '');
const API = opt('api', 'https://api.asepsico.es/api/v1').replace(/\/+$/, '');
const APP_ORIGIN = opt('origin', 'https://app.asepsico.es');
const BEFORE_CUT = args.includes('--antes-del-corte');

let failures = 0;
const ok = (msg) => console.log(`OK     ${msg}`);
const bad = (msg) => { failures += 1; console.log(`FALLO  ${msg}`); };
const check = (cond, msg, detail = '') => (cond ? ok(msg) : bad(detail ? `${msg} (${detail})` : msg));
const get = (url, init = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(150_000), ...init });
const h = (res, name) => (res.headers.get(name) ?? '').toLowerCase();
const sha = (t) => `sha256-${createHash('sha256').update(t, 'utf8').digest('base64')}`;

async function main() {
  console.log(`App: ${APP} · API: ${API}${BEFORE_CUT ? ' · antes del corte' : ''}\n`);

  // 0. La API responde (puede tardar ~1 min si estaba dormida).
  const health = await get(`${API}/health`).catch(() => null);
  check(health?.status === 200, 'API /health responde 200', health ? `código ${health.status}` : 'sin respuesta');

  // 1. Portada: cabeceras globales y CSP efectiva sin 'unsafe-inline' (meta con hashes).
  const home = await get(`${APP}/`);
  const homeHtml = await home.text();
  check(home.status === 200, 'portada 200', `código ${home.status}`);
  check(h(home, 'strict-transport-security').includes('max-age='), 'Strict-Transport-Security');
  check(h(home, 'x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
  check(h(home, 'referrer-policy') === 'no-referrer', 'Referrer-Policy: no-referrer');
  check(h(home, 'x-frame-options') === 'deny', 'X-Frame-Options: DENY');
  check(h(home, 'x-robots-tag').includes('noindex'), 'X-Robots-Tag: noindex');
  const csp = h(home, 'content-security-policy');
  check(csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"), 'cabecera CSP con frame-ancestors y object-src');
  check(csp.includes(new URL(API).origin), 'cabecera CSP: connect-src incluye la API');
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i.exec(homeHtml)?.[1] ?? '';
  check(meta.startsWith("script-src 'self'") && !meta.includes('unsafe-inline'), "meta CSP por página sin 'unsafe-inline'");
  const inline = [...homeHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1]) && !/type="application\/json"/i.test(m[1]));
  check(inline.length > 0 && inline.every((m) => meta.includes(sha(m[2]))), `los ${inline.length} scripts inline de la portada tienen su hash`);

  // 2. Ruta desconocida: 404 propia, nunca reescritura SPA a index.html (200).
  const unknown = await get(`${APP}/ruta-que-no-existe-${Date.now()}/`);
  const unknownHtml = await unknown.text();
  check(unknown.status === 404, 'ruta desconocida → 404 (sin reescritura /* → /index.html)', `código ${unknown.status}`);
  check(unknownHtml !== homeHtml && unknownHtml.length > 0, 'la 404 es 404.html, no la portada');

  // 3. Rutas sin barra final: se sirven o redirigen a la misma ruta con barra.
  for (const path of ['/portal/alta', '/portal/activar', '/register', '/agenda']) {
    const res = await get(`${APP}${path}`);
    const loc = res.headers.get('location') ?? '';
    const fine = res.status === 200 || ([301, 302, 307, 308].includes(res.status) && new URL(loc, APP).pathname === `${path}/`);
    check(fine, `${path} sin barra → 200 o redirección a ${path}/`, `código ${res.status}${loc ? ` → ${loc}` : ''}`);
  }

  // 4. Páginas sensibles: no-store, noindex, no-referrer.
  for (const path of ['/portal/alta/', '/portal/activar/', '/admin/lista-espera/']) {
    const res = await get(`${APP}${path}`);
    check(res.status === 200, `${path} 200`, `código ${res.status}`);
    check(h(res, 'cache-control').includes('no-store'), `${path} Cache-Control: no-store`, h(res, 'cache-control') || 'sin cabecera');
    check(h(res, 'x-robots-tag').includes('noindex'), `${path} X-Robots-Tag: noindex`);
    check(h(res, 'referrer-policy') === 'no-referrer', `${path} Referrer-Policy: no-referrer`);
  }

  // 5. Recursos estáticos con caché larga.
  const asset = /<script src="(\/_next\/static\/[^"]+)"/.exec(homeHtml)?.[1];
  if (asset) {
    const res = await get(`${APP}${asset}`, { method: 'HEAD' });
    check(h(res, 'cache-control').includes('immutable'), '/_next/static/* con Cache-Control immutable');
  } else bad('no se encontró ningún /_next/static/ en la portada');

  // 6. CORS de la API: nunca para un origen ajeno; para app. solo tras el corte.
  const preflight = (origin) => get(`${API}/auth/login`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
  // Con WEB_ORIGIN fijo, el paquete cors de Nest responde SIEMPRE con ese origen (no con el que
  // llega): eso no autoriza a evil.example. Lo que nunca puede salir es su origen ni '*'.
  const evil = await preflight('https://evil.example');
  const evilAcao = evil.headers.get('access-control-allow-origin');
  check(!evilAcao || (evilAcao !== 'https://evil.example' && evilAcao !== '*'), 'OPTIONS con Origin https://evil.example: no se le permite (ni su origen ni *)', evilAcao ?? '');
  const app = await preflight(APP_ORIGIN);
  const acao = app.headers.get('access-control-allow-origin');
  if (BEFORE_CUT) {
    console.log(`INFO   antes del corte: Access-Control-Allow-Origin para ${APP_ORIGIN} = ${acao ?? '(ninguno)'} (normal)`);
  } else {
    check(acao === APP_ORIGIN, `OPTIONS con Origin ${APP_ORIGIN}: lo permite`, acao ?? 'sin cabecera');
    check(h(app, 'access-control-allow-credentials') === 'true', 'Access-Control-Allow-Credentials: true');
  }

  console.log(failures ? `\nRESULTADO: ${failures} FALLO(S)` : '\nRESULTADO: TODO OK');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.log(`FALLO  error inesperado: ${error instanceof Error ? error.message : error}`); process.exit(1); });
