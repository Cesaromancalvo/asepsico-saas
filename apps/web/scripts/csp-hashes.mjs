#!/usr/bin/env node
/*
 * postbuild del export estático: CSP sin 'unsafe-inline' para los scripts.
 *
 * Next exportado mete scripts inline sin nonce (self.__next_f.push(...)) y cambian en cada build,
 * así que no caben en una cabecera fija de Render. Este paso calcula el sha256 de los scripts
 * inline de CADA página y escribe en su <head> un
 *   <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-…' …">
 * El navegador aplica a la vez la cabecera de Render y esta meta (gana la más estricta): los
 * scripts inline que no estén en la lista no se ejecutan aunque la cabecera diga 'unsafe-inline'.
 * frame-ancestors, connect-src, etc. siguen en la cabecera (frame-ancestors no vale en <meta>).
 *
 * Falla cerrado: si una página con scripts inline no puede llevar la meta, termina con código 1.
 * Uso: node scripts/csp-hashes.mjs [carpeta]   (por defecto apps/web/out)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const META_RE = /<meta http-equiv="Content-Security-Policy" content="[^"]*"\/?>/i;
const CHARSET_RE = /<meta charSet="utf-8"\/>|<meta charset="utf-8"\/?>/i;

export function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const type = /\btype\s*=\s*"([^"]*)"/i.exec(m[1])?.[1];
    if (type && !/^(text|application)\/(javascript|ecmascript)$|^module$/i.test(type)) continue; // datos (JSON): no se ejecutan
    out.push(m[2]);
  }
  return out;
}

export function sha256(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

export function policyFor(html) {
  const hashes = [...new Set(inlineScripts(html).map(sha256))];
  return `script-src 'self' ${hashes.join(' ')}`.trim() + "; object-src 'none'; base-uri 'self'";
}

/** Devuelve el HTML con la meta CSP (reemplaza la anterior si ya estaba). null si no puede. */
export function withCspMeta(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policyFor(html.replace(META_RE, ''))}"/>`;
  if (META_RE.test(html)) return html.replace(META_RE, meta);
  const charset = CHARSET_RE.exec(html);
  if (!charset) return null;
  const at = charset.index + charset[0].length;
  return html.slice(0, at) + meta + html.slice(at);
}

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? htmlFiles(p) : name.endsWith('.html') ? [p] : [];
  });
}

export function run(dir) {
  let pages = 0, scripts = 0;
  const failed = [];
  for (const file of htmlFiles(dir)) {
    const html = readFileSync(file, 'utf8');
    const next = withCspMeta(html);
    if (next === null) {
      if (inlineScripts(html).length) failed.push(file);
      continue;
    }
    writeFileSync(file, next);
    pages += 1;
    scripts += inlineScripts(html).length;
  }
  return { pages, scripts, failed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
  const { pages, scripts, failed } = run(dir);
  if (failed.length || pages === 0) {
    console.error(`csp-hashes: FALLO. Páginas sin meta CSP: ${failed.length ? failed.join(', ') : '(ninguna página procesada)'}`);
    process.exit(1);
  }
  console.log(`csp-hashes: OK (${pages} páginas, ${scripts} scripts inline con hash; sin 'unsafe-inline' efectivo).`);
}
