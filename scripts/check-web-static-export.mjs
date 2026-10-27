#!/usr/bin/env node
/**
 * Condición de Argos (revisión C4, 26/10/2026, A1): después de `next build`, comprueba que la web
 * de la app salió como export estático y sin proxy de la API:
 *  1. existe apps/web/out/index.html y apps/web/out/404.html (lo que publica Render Static Site);
 *  2. no hay salida `standalone` (servidor de Next);
 *  3. routes-manifest.json no tiene rewrites ni headers propios (solo las redirecciones internas
 *     de trailingSlash que Next añade y que en un export no se aplican);
 *  4. ningún fichero publicado menciona API_INTERNAL_URL ni llama a /api/v1 en relativo.
 *
 * Uso: npm --workspace @asepsico/web run build && node scripts/check-web-static-export.mjs
 * Sin dependencias, sin red. Termina con código 1 si falla algo.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const web = join(repoRoot, 'apps/web');
const out = join(web, 'out');
const dotNext = join(web, '.next');

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'OK   ' : 'FALLO'}  ${msg}`);
  if (!cond) failures += 1;
};

check(existsSync(join(out, 'index.html')), 'apps/web/out/index.html existe (export estático)');
check(existsSync(join(out, '404.html')), 'apps/web/out/404.html existe (404 propia)');
check(!existsSync(join(dotNext, 'standalone')), "sin apps/web/.next/standalone (nada de output: 'standalone')");

const manifestPath = join(dotNext, 'routes-manifest.json');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rw = manifest.rewrites ?? [];
  const rewrites = Array.isArray(rw) ? rw : [...(rw.beforeFiles ?? []), ...(rw.afterFiles ?? []), ...(rw.fallback ?? [])];
  check(rewrites.length === 0, `routes-manifest: 0 rewrites (hay ${rewrites.length})`);
  check((manifest.headers ?? []).length === 0, 'routes-manifest: 0 headers (las cabeceras van en Render)');
  const ownRedirects = (manifest.redirects ?? []).filter((r) => !r.internal);
  check(ownRedirects.length === 0, `routes-manifest: 0 redirects propios (hay ${ownRedirects.length})`);
} else {
  check(false, 'falta apps/web/.next/routes-manifest.json: ¿se ejecutó next build?');
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(?:html|js|txt|json)$/.test(name)) yield full;
  }
}
if (existsSync(out)) {
  const proxy = [];
  const relativeApi = [];
  for (const file of files(out)) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('API_INTERNAL_URL')) proxy.push(relative(repoRoot, file));
    if (/["'`]\/api\/v1\//.test(text)) relativeApi.push(relative(repoRoot, file));
  }
  check(proxy.length === 0, `ningún fichero publicado menciona API_INTERNAL_URL${proxy.length ? `: ${proxy.slice(0, 5).join(', ')}` : ''}`);
  check(relativeApi.length === 0, `ninguna llamada relativa a /api/v1/${relativeApi.length ? `: ${relativeApi.slice(0, 5).join(', ')}` : ''}`);
}

if (failures > 0) {
  console.log(`\n${failures} comprobación(es) fallida(s): la web no es un export estático limpio.`);
  process.exit(1);
}
console.log('\nTODO OK: export estático sin proxy de la API.');
