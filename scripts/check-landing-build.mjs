#!/usr/bin/env node
/**
 * Prueba el build de publicación de la landing (apps/landing/build.mjs) con datos FICTICIOS:
 *  1. con NIF y domicilio válidos: termina bien, no queda ningún marcador, los valores aparecen en
 *     aviso-legal y privacidad, y la salida pasa check-landing --require-filled (CSP intacta);
 *  2. sin variables, o con NIF / domicilio mal formados: falla (exit 1) y no publica;
 *  3. en ningún caso escribe los valores en stdout/stderr (el log de build de Render se guarda).
 *
 * Uso: node scripts/check-landing-build.mjs   (lo llama npm run test:landing). Sin dependencias.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const build = join(repoRoot, 'apps/landing/build.mjs');
const check = join(repoRoot, 'scripts/check-landing.mjs');

// Datos inventados: 00000000T es un DNI con letra de control válida que no pertenece a nadie.
const FAKE_NIF = '00000000T';
const FAKE_ADDRESS = 'Calle Ficticia 1, 00000 Ninguna';

const failures = [];
const tmp = mkdtempSync(join(tmpdir(), 'landing-build-'));

function run(script, args, env) {
  const base = { ...process.env };
  delete base.LEGAL_TITULAR_NIF;
  delete base.LEGAL_TITULAR_DOMICILIO;
  const r = spawnSync(process.execPath, [script, ...args], { env: { ...base, ...env }, encoding: 'utf8' });
  const output = `${r.stdout}${r.stderr}`;
  for (const secret of [FAKE_NIF, FAKE_ADDRESS, ...Object.values(env)]) {
    if (secret && output.includes(secret)) failures.push(`${script}: la salida contiene un valor de una variable`);
  }
  return { status: r.status, output };
}

try {
  // 1. Build correcto.
  const ok = join(tmp, 'ok');
  const r1 = run(build, ['--out', ok], { LEGAL_TITULAR_NIF: FAKE_NIF, LEGAL_TITULAR_DOMICILIO: FAKE_ADDRESS });
  if (r1.status !== 0) failures.push(`build válido terminó con código ${r1.status}: ${r1.output.trim()}`);
  else {
    const aviso = readFileSync(join(ok, 'aviso-legal/index.html'), 'utf8');
    const priv = readFileSync(join(ok, 'privacidad/index.html'), 'utf8');
    if (!aviso.includes(`<dd>${FAKE_NIF}</dd>`)) failures.push('aviso-legal: no aparece el NIF');
    if (!aviso.includes(`<dd>${FAKE_ADDRESS}</dd>`)) failures.push('aviso-legal: no aparece el domicilio');
    if (!priv.includes(`<dd>${FAKE_ADDRESS}</dd>`)) failures.push('privacidad: no aparece el domicilio');
    const c = run(check, [ok, '--require-filled'], {});
    if (c.status !== 0) failures.push(`check-landing --require-filled sobre la salida falló:\n${c.output}`);
    // El código fuente sigue con los marcadores (no se ha escrito nada en public/).
    const srcAviso = readFileSync(join(repoRoot, 'apps/landing/public/aviso-legal/index.html'), 'utf8');
    if (!srcAviso.includes('[[NIF]]')) failures.push('public/aviso-legal ya no tiene [[NIF]]: el build no debe escribir en public/');
  }

  // 2. Casos que deben fallar sin publicar.
  const bad = [
    ['sin variables', {}],
    ['sin domicilio', { LEGAL_TITULAR_NIF: FAKE_NIF }],
    ['NIF con letra incorrecta', { LEGAL_TITULAR_NIF: '00000000A', LEGAL_TITULAR_DOMICILIO: FAKE_ADDRESS }],
    ['domicilio con HTML', { LEGAL_TITULAR_NIF: FAKE_NIF, LEGAL_TITULAR_DOMICILIO: 'Calle <b>Falsa</b> 123, 00000' }],
    ['domicilio demasiado corto', { LEGAL_TITULAR_NIF: FAKE_NIF, LEGAL_TITULAR_DOMICILIO: 'C/ 1' }],
  ];
  for (const [name, env] of bad) {
    const out = join(tmp, name.replace(/\W+/g, '-'));
    const r = run(build, ['--out', out], env);
    if (r.status === 0) failures.push(`${name}: el build debía fallar y terminó bien`);
    if (existsSync(out)) failures.push(`${name}: el build falló pero dejó salida en ${out}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  for (const f of failures) console.error(`ERROR   ${f}`);
  console.error(`\ncheck-landing-build: ${failures.length} problema(s).`);
  process.exit(1);
}
console.log('check-landing-build: OK (build con datos ficticios, 5 casos de fallo cerrado, sin valores en el log).');
