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
 *   - el origen de la API de la lista de espera (CONNECT_ORIGINS) fuera de js/config.js o sin https;
 *   - una CSP documentada en apps/landing/README.md cuyo connect-src no sea exactamente
 *     'self' + CONNECT_ORIGINS, o sin form-action 'none'.
 *   - (con --require-filled, para la salida de apps/landing/build.mjs) un marcador [[...]] sin
 *     rellenar. Sin esa opción, [[NIF]] y [[DOMICILIO]] son lo esperado en el código fuente.
 *
 * Uso: node scripts/check-landing.mjs [directorio] [--require-filled]
 *      (por defecto apps/landing/public)
 * Sin dependencias.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dominios permitidos (y sus subdominios). Solo enlaces que el visitante pulsa, nunca recursos
// que se carguen solos. Los tres últimos los cita la política de la lista de espera.
const ALLOWED_HOSTS = ['asepsico.es', 'forms.gle', 'instagram.com', 'policies.google.com', 'dataprivacyframework.gov', 'aepd.es'];

// Orígenes a los que el navegador puede hacer peticiones (fetch): la API propia de la lista de espera.
// Coincidencia EXACTA (sin subdominios: onrender.com aloja a cualquiera), solo en js/config.js
// (WAITLIST_API_URL) y solo con https. Es lo mismo que va en connect-src de la CSP (README).
const CONNECT_ORIGINS = ['https://asepsico-api.onrender.com'];
const CONNECT_FILE = 'js/config.js';

// Archivos que no son contenido de la web (licencias) y pueden citar URLs ajenas.
const IGNORED_FILES = new Set(['fonts/OFL.txt']);
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.xml', '.txt', '.json', '.svg', '.webmanifest']);
const MARKUP_EXTENSIONS = new Set(['.html', '.htm', '.svg', '.xml']);

// Marcadores que apps/landing/build.mjs sustituye al publicar (NIF y domicilio del titular).
const KNOWN_MARKERS = new Set(['[[NIF]]', '[[DOMICILIO]]']);

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const requireFilled = args.includes('--require-filled');
const dirArg = args.find((a) => !a.startsWith('--'));
const root = resolve(dirArg ?? join(repoRoot, 'apps/landing/public'));
let markers = 0;

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
    const connect = CONNECT_ORIGINS.find((o) => new URL(o).host === m[1].toLowerCase());
    if (connect) {
      if (rel !== CONNECT_FILE) report(problems, rel, text, m.index, `el origen de la API (${m[1]}) solo puede estar en ${CONNECT_FILE}`);
      else if (!m[0].toLowerCase().startsWith(connect)) report(problems, rel, text, m.index, `el origen de la API tiene que ser exactamente ${connect}`);
      continue;
    }
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

  // Marcadores de datos del titular. En el código fuente son lo esperado (el repo es público: los
  // rellena apps/landing/build.mjs al publicar); en la salida del build (--require-filled) son error.
  for (const m of raw.matchAll(/\[\[[A-ZÁÉÍÓÚÜÑ_ ]+\]\]/g)) {
    if (requireFilled) report(problems, rel, raw, m.index, `marcador sin rellenar: ${m[0]}`);
    else if (!KNOWN_MARKERS.has(m[0])) report(problems, rel, raw, m.index, `marcador desconocido: ${m[0]} (build.mjs no lo rellena)`);
    else markers += 1;
  }
}

// CSP documentada para Render (README de la landing): connect-src = 'self' + la API, y nada más;
// form-action 'none' (el formulario se envía con fetch).
{
  const readme = join(repoRoot, 'apps/landing/README.md');
  let md = '';
  try { md = readFileSync(readme, 'utf8'); } catch { problems.push('apps/landing/README.md: no existe'); }
  const cspLine = md.split('\n').find((l) => l.startsWith('Content-Security-Policy:'));
  if (md && !cspLine) problems.push('apps/landing/README.md: falta la línea Content-Security-Policy');
  if (cspLine) {
    const directives = Object.fromEntries(cspLine.slice('Content-Security-Policy:'.length).split(';')
      .map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v.join(' ')]));
    const expected = ["'self'", ...CONNECT_ORIGINS].join(' ');
    if (directives['connect-src'] !== expected) {
      problems.push(`apps/landing/README.md: connect-src debe ser exactamente "${expected}" (es "${directives['connect-src'] ?? ''}")`);
    }
    if (directives['form-action'] !== "'none'") problems.push("apps/landing/README.md: form-action debe ser 'none'");
    for (const k of ['default-src', 'script-src', 'style-src', 'img-src', 'font-src']) {
      if (directives[k] !== "'self'") problems.push(`apps/landing/README.md: ${k} debe ser 'self'`);
    }
  }
}

for (const w of warnings) console.warn(`AVISO   ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`ERROR   ${p}`);
  console.error(`\ncheck-landing: ${problems.length} problema(s) en ${relative(repoRoot, root) || root}.`);
  process.exit(1);
}
const markerNote = markers ? `; ${markers} marcadores de datos del titular que rellena build.mjs al publicar` : '';
console.log(`check-landing: OK (${scanned} archivos revisados; dominios permitidos: ${ALLOWED_HOSTS.join(', ')}; connect-src: ${CONNECT_ORIGINS.join(', ')}${markerNote}).`);
