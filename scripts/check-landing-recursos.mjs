#!/usr/bin/env node
/**
 * Prueba que check-landing detecta de verdad (pendiente de Quima, 08/11):
 *  - que falte el PDF /recursos/mapa-semana-consulta.pdf o su página /recursos/mapa-semana-consulta/;
 *  - que ninguna página enlace a ellos, o que un enlace interno a /recursos/ esté roto;
 *  - un enlace http:// en la landing (solo https), sin confundirlo con un xmlns.
 * Copia apps/landing/public a un directorio temporal, rompe una cosa cada vez y exige exit 1;
 * con la copia intacta exige exit 0. Además pasa la salida real del build (con datos FICTICIOS) y
 * comprueba que el PDF y la página están en ella.
 *
 * Uso: node scripts/check-landing-recursos.mjs   (lo llama npm run test:landing). Sin dependencias.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = join(repoRoot, 'apps/landing/public');
const check = join(repoRoot, 'scripts/check-landing.mjs');
const build = join(repoRoot, 'apps/landing/build.mjs');
const PDF = 'recursos/mapa-semana-consulta.pdf';
const PAGE = 'recursos/mapa-semana-consulta/index.html';

const failures = [];
const tmp = mkdtempSync(join(tmpdir(), 'landing-recursos-'));
let n = 0;

function copy() {
  const dir = join(tmp, `case-${(n += 1)}`);
  cpSync(publicDir, dir, { recursive: true });
  return dir;
}
function runCheck(dir, extra = []) {
  const r = spawnSync(process.execPath, [check, dir, ...extra], { encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}
function edit(dir, file, fn) {
  const full = join(dir, file);
  writeFileSync(full, fn(readFileSync(full, 'utf8')));
}
function expectFail(label, dir, needle) {
  const r = runCheck(dir);
  if (r.status !== 1) failures.push(`${label}: check-landing debía fallar y terminó con ${r.status}`);
  else if (!r.output.includes(needle)) failures.push(`${label}: el error no menciona «${needle}»:\n${r.output}`);
}

try {
  // Control: la copia intacta pasa.
  const okDir = copy();
  const ok = runCheck(okDir);
  if (ok.status !== 0) failures.push(`copia intacta: check-landing falló:\n${ok.output}`);

  // Faltan los recursos.
  { const d = copy(); rmSync(join(d, PDF)); expectFail('sin el PDF', d, 'mapa-semana-consulta.pdf'); }
  { const d = copy(); rmSync(join(d, PAGE)); expectFail('sin la página del recurso', d, 'mapa-semana-consulta/'); }

  // Nadie enlaza al PDF (se quita el enlace de la página del recurso).
  {
    const d = copy();
    edit(d, PAGE, (t) => t.split('href="/recursos/mapa-semana-consulta.pdf"').join('href="/"'));
    expectFail('sin enlace al PDF', d, 'ninguna página enlaza a /recursos/mapa-semana-consulta.pdf');
  }
  // Enlace interno roto a /recursos/.
  {
    const d = copy();
    edit(d, 'index.html', (t) => t.replace('href="/recursos/mapa-semana-consulta/"', 'href="/recursos/no-existe.pdf"'));
    expectFail('enlace interno roto', d, 'enlace interno roto: /recursos/no-existe.pdf');
  }

  // http:// en un enlace, en un recurso y en el JSON-LD.
  {
    const d = copy();
    edit(d, 'index.html', (t) => t.replace('href="https://', 'href="http://'));
    expectFail('enlace http:// en index.html', d, 'enlace http:// (solo https)');
  }
  {
    const d = copy();
    edit(d, PAGE, (t) => t.replace('https://asepsico.es/recursos/mapa-semana-consulta/', 'http://asepsico.es/recursos/mapa-semana-consulta/'));
    expectFail('http:// en la página del recurso', d, 'enlace http:// (solo https)');
  }
  // Un xmlns http:// no es un enlace: sigue pasando (index.html y los SVG ya lo llevan).
  if (!readFileSync(join(okDir, 'index.html'), 'utf8').includes('xmlns="http://www.w3.org/2000/svg"')) {
    failures.push('control: index.html ya no tiene un xmlns http:// (revisa este caso)');
  }

  // La salida real del build lleva la página y el PDF, y pasa check-landing --require-filled.
  {
    const out = join(tmp, 'build');
    const env = { ...process.env, LEGAL_TITULAR_NIF: '00000000T', LEGAL_TITULAR_DOMICILIO: 'Calle Ficticia 1, 00000 Ninguna' };
    const b = spawnSync(process.execPath, [build, '--out', out], { env, encoding: 'utf8' });
    if (b.status !== 0) failures.push(`build con datos ficticios terminó con ${b.status}`);
    else {
      for (const file of [PDF, PAGE]) if (!existsSync(join(out, file))) failures.push(`build: falta ${file}`);
      const c = runCheck(out, ['--require-filled']);
      if (c.status !== 0) failures.push(`build: check-landing --require-filled falló:\n${c.output}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  for (const f of failures) console.error(`FALLO   ${f}`);
  console.error(`\ncheck-landing-recursos: ${failures.length} fallo(s).`);
  process.exit(1);
}
console.log('check-landing-recursos: OK (PDF y página del mapa en la fuente y en el build; detecta recurso ausente, sin enlazar, enlace roto y http://).');
