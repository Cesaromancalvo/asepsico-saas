#!/usr/bin/env node
/**
 * Build de publicación de la landing (Render Static Site).
 *
 * El repositorio es público: el NIF y el domicilio del titular NO están en el código. Los HTML
 * llevan los marcadores [[NIF]] y [[DOMICILIO]], y este script los sustituye al publicar con las
 * variables de entorno del Static Site:
 *
 *   LEGAL_TITULAR_NIF        DNI (8 cifras + letra) o NIE (X/Y/Z + 7 cifras + letra), letra válida
 *   LEGAL_TITULAR_DOMICILIO  una línea postal, 10-200 caracteres
 *
 * (Mismos nombres y mismas reglas que la API: apps/api/src/legal/legal-documents.ts.)
 *
 * Copia public/ a dist/ (o a --out <dir>) y sustituye los marcadores SOLO en los .html.
 * Falla cerrado (exit 1, sin publicar) si falta una variable, si tiene un formato no válido o si
 * queda algún marcador [[...]] en la salida. Render mantiene entonces la versión anterior.
 *
 * NUNCA escribe los valores en la salida (el log de build de Render se guarda): solo recuentos.
 *
 * Uso:
 *   node build.mjs                    (Render: Root Directory apps/landing, Publish Directory dist)
 *   node build.mjs --out /tmp/x       (tests: scripts/check-landing-build.mjs)
 * Sin dependencias.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'public');
const outArg = process.argv.indexOf('--out');
const out = resolve(outArg > -1 && process.argv[outArg + 1] ? process.argv[outArg + 1] : join(here, 'dist'));

const NIF_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

function normalizeNif(raw) {
  const value = raw.replace(/[\s.-]/g, '').toUpperCase();
  const match = /^([0-9XYZ])([0-9]{7})([A-Z])$/.exec(value);
  if (!match) return null;
  const niePrefix = 'XYZ'.indexOf(match[1]);
  const digits = (niePrefix >= 0 ? String(niePrefix) : match[1]) + match[2];
  return NIF_LETTERS[Number(digits) % 23] === match[3] ? value : null;
}

function normalizeAddress(raw) {
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length < 10 || value.length > 200) return null;
  return /^[\p{L}\p{N} .,ºª°'’/()-]+$/u.test(value) ? value : null;
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const PLACEHOLDERS = [
  { marker: '[[NIF]]', env: 'LEGAL_TITULAR_NIF', normalize: normalizeNif },
  { marker: '[[DOMICILIO]]', env: 'LEGAL_TITULAR_DOMICILIO', normalize: normalizeAddress },
];

function fail(message) {
  console.error(`build-landing: ${message}. No se publica nada (Render mantiene la versión anterior).`);
  process.exit(1);
}

// 1. Validar las variables antes de tocar nada. Los mensajes nunca incluyen el valor.
const values = new Map();
for (const { marker, env, normalize } of PLACEHOLDERS) {
  const raw = process.env[env];
  if (!raw || !raw.trim()) fail(`falta la variable ${env} (Render → Static Site → Environment)`);
  const value = normalize(raw);
  if (!value) fail(`${env} tiene un formato no válido`);
  values.set(marker, escapeHtml(value));
}

// 2. Copiar public/ → salida limpia.
if (!existsSync(src)) fail('no existe apps/landing/public');
if (out === src || out === here || src.startsWith(`${out}/`)) fail('directorio de salida no válido');
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

// 3. Sustituir en los HTML y comprobar que no queda ningún marcador en ningún archivo de texto.
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const TEXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.xml', '.txt', '.json', '.svg', '.webmanifest']);
let filesChanged = 0;
let replacements = 0;
const leftovers = [];
for (const full of walk(out)) {
  const ext = extname(full).toLowerCase();
  if (!TEXT.has(ext)) continue;
  let text = readFileSync(full, 'utf8');
  if (ext === '.html' || ext === '.htm') {
    let changed = false;
    for (const [marker, value] of values) {
      const parts = text.split(marker);
      if (parts.length > 1) {
        replacements += parts.length - 1;
        text = parts.join(value);
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(full, text);
      filesChanged += 1;
    }
  }
  if (/\[\[[A-ZÁÉÍÓÚÜÑ_ ]+\]\]/.test(text)) leftovers.push(relative(out, full));
}

if (leftovers.length) fail(`quedan marcadores [[...]] sin rellenar en: ${leftovers.join(', ')}`);
if (replacements === 0) fail('no se ha sustituido ningún marcador (¿se ha cambiado el HTML?)');

console.log(`build-landing: OK (${replacements} marcadores sustituidos en ${filesChanged} archivos; salida ${relative(here, out) || out}).`);
