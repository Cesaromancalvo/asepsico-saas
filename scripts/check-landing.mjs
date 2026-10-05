#!/usr/bin/env node
/**
 * Comprueba que la landing estática (apps/landing/public) no hace peticiones a terceros
 * ni rompe una CSP estricta. Falla (exit 1) si encuentra:
 *   - un dominio externo fuera de ALLOWED_HOSTS (en HTML, CSS, JS, XML, TXT, JSON o SVG);
 *   - un <iframe>, <object>, <embed> o <frame>;
 *   - estilos en línea (atributo style= o etiqueta <style>);
 *   - scripts en línea (<script> sin src o con contenido), manejadores on*= o URL javascript:.
 * Los comentarios (HTML y CSS/JS) no se tienen en cuenta: no se ejecutan ni se descargan.
 *
 * Uso: node scripts/check-landing.mjs [directorio]   (por defecto apps/landing/public)
 * Sin dependencias.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dominios permitidos (y sus subdominios). Solo enlaces que el visitante pulsa, nunca recursos
// que se carguen solos. TODO: añadir aquí el dominio de la política de privacidad del formulario
// de la lista de espera cuando se rellene FORM_PRIVACY_URL en js/config.js.
const ALLOWED_HOSTS = ['asepsico.es', 'forms.gle', 'instagram.com'];

// Archivos que no son contenido de la web (licencias) y pueden citar URLs ajenas.
const IGNORED_FILES = new Set(['fonts/OFL.txt']);
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.xml', '.txt', '.json', '.svg', '.webmanifest']);
const MARKUP_EXTENSIONS = new Set(['.html', '.htm', '.svg', '.xml']);

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(process.argv[2] ?? join(repoRoot, 'apps/landing/public'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// Sustituye los comentarios por espacios del mismo tamaño para conservar los números de línea.
function blank(match) {
  return match.replace(/[^\n]/g, ' ');
}
function stripComments(text, ext) {
  let out = text;
  if (MARKUP_EXTENSIONS.has(ext)) out = out.replace(/<!--[\s\S]*?-->/g, blank);
  if (ext === '.css' || ext === '.js' || ext === '.mjs') {
    out = out.replace(/\/\*[\s\S]*?\*\//g, blank);
    out = out.replace(/^\s*\/\/.*$/gm, blank);
  }
  return out;
}

function hostAllowed(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return ALLOWED_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

const problems = [];
const warnings = [];
const report = (list, file, text, index, message) =>
  list.push(`${file}:${lineOf(text, index)}  ${message}`);

let files;
try {
  files = walk(root);
} catch {
  console.error(`check-landing: no existe el directorio ${root}`);
  process.exit(1);
}

let scanned = 0;
for (const full of files) {
  const rel = relative(root, full).split('\\').join('/');
  const ext = extname(full).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) || IGNORED_FILES.has(rel)) continue;
  scanned += 1;
  const raw = readFileSync(full, 'utf8');
  const text = stripComments(raw, ext);

  // 0. Bloques de datos JSON-LD: no se ejecutan ni descargan nada (la CSP no les aplica). Se exige
  //    JSON válido, sin src, y que sus URLs sean de la propia web o el identificador de schema.org.
  //    Después se ocultan para el resto de comprobaciones (schema.org NO es un dominio permitido fuera).
  let scan = text;
  if (MARKUP_EXTENSIONS.has(ext)) {
    scan = text.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (block, attrs, body, offset) => {
      if (!/\stype\s*=\s*["']application\/ld\+json["']/i.test(` ${attrs}`)) return block;
      if (/\ssrc\s*=/i.test(` ${attrs}`)) report(problems, rel, text, offset, 'JSON-LD con src');
      try { JSON.parse(body); } catch { report(problems, rel, text, offset, 'JSON-LD no es JSON válido'); }
      for (const u of body.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        const host = u[1].toLowerCase();
        if (host !== 'schema.org' && !hostAllowed(host)) {
          report(problems, rel, text, offset + block.indexOf(u[0]), `dominio externo no permitido en JSON-LD: ${host}`);
        }
      }
      return blank(block);
    });
  }

  // 1. Dominios externos (absolutos o relativos al protocolo).
  const urlRe = /(?:\b(?:https?|wss?|ftp):)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?/gi;
  for (const m of scan.matchAll(urlRe)) {
    const before = scan.slice(Math.max(0, m.index - 16), m.index);
    if (/xmlns(?::[a-z]+)?\s*=\s*["']?(?:https?:)?$/i.test(before)) continue; // espacios de nombres XML
    if (!/^(?:https?|wss?|ftp):/i.test(m[0]) && !/["'(=\s]$/.test(before)) continue; // no es una URL
    if (!hostAllowed(m[1])) report(problems, rel, text, m.index, `dominio externo no permitido: ${m[1]}`);
  }

  if (MARKUP_EXTENSIONS.has(ext)) {
    // 2. Contenido incrustado.
    for (const m of scan.matchAll(/<(iframe|frame|object|embed)\b/gi)) {
      report(problems, rel, text, m.index, `etiqueta <${m[1].toLowerCase()}> no permitida`);
    }
    // 3. Estilos en línea.
    for (const m of scan.matchAll(/<style\b/gi)) report(problems, rel, text, m.index, 'etiqueta <style> en línea');
    for (const m of scan.matchAll(/<[a-z][^>]*?\sstyle\s*=/gi)) report(problems, rel, text, m.index, 'atributo style= en línea');
    // 4. Scripts en línea (los JSON-LD ya se han validado y ocultado en el paso 0).
    for (const m of scan.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const hasSrc = /\ssrc\s*=/i.test(` ${m[1]}`);
      if (!hasSrc || m[2].trim() !== '') report(problems, rel, text, m.index, '<script> en línea (usa un archivo con src)');
    }
    for (const m of scan.matchAll(/<[a-z][^>]*?\son[a-z]+\s*=/gi)) report(problems, rel, text, m.index, 'manejador de eventos on*= en línea');
  }
  for (const m of scan.matchAll(/javascript\s*:/gi)) report(problems, rel, text, m.index, 'URL javascript: no permitida');

  // Aviso (no falla): datos legales pendientes.
  for (const m of raw.matchAll(/\[\[(NIF|DOMICILIO)\]\]/g)) {
    report(warnings, rel, raw, m.index, `pendiente: ${m[0]} (rellenar antes de publicar)`);
  }
}

for (const w of warnings) console.warn(`AVISO   ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`ERROR   ${p}`);
  console.error(`\ncheck-landing: ${problems.length} problema(s) en ${relative(repoRoot, root) || root}.`);
  process.exit(1);
}
console.log(`check-landing: OK (${scanned} archivos revisados; dominios permitidos: ${ALLOWED_HOSTS.join(', ')}).`);
