/**
 * Condición de Argos (revisión C4, 26/10/2026, hallazgo A1): la web de la app es un export estático
 * (Render Static Site) y NUNCA vuelve a hacer de proxy de la API. Si alguien reintroduce
 * `output: 'standalone'`, un `rewrites()` hacia `API_INTERNAL_URL` o cualquier función que exija
 * servidor de Next, este test falla en CI antes de llegar a `main`.
 *
 * El build en sí se comprueba después de `next build` con `scripts/check-web-static-export.mjs`
 * (paso del job `quality` en .github/workflows/ci.yml).
 */
import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const webRoot = resolve(__dirname, '..');
const configPath = join(webRoot, 'next.config.mjs');

/** Carga next.config.mjs en un proceso aparte (ESM) y devuelve su forma, no sus valores. */
function loadConfigShape(): Record<string, string> {
  const script = `
    const mod = await import(${JSON.stringify(pathToFileURL(configPath).href)});
    const cfg = typeof mod.default === 'function' ? await mod.default('phase-production-build', {}) : mod.default;
    const shape = {};
    for (const [k, v] of Object.entries(cfg)) shape[k] = typeof v === 'function' ? 'function' : JSON.stringify(v);
    process.stdout.write(JSON.stringify(shape));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: webRoot,
    env: { ...process.env, API_INTERNAL_URL: 'http://proxy-que-no-debe-usarse.invalid' },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'test']);
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|json)$/;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (SOURCE_EXT.test(name)) files.push(full);
  }
  return files;
}

describe('apps/web es un export estático sin proxy de la API (A1)', () => {
  const shape = loadConfigShape();

  it("next.config.mjs usa output: 'export' (no 'standalone')", () => {
    expect(shape.output).toBe(JSON.stringify('export'));
  });

  it('no define rewrites, redirects ni headers (exigen servidor de Next)', () => {
    expect(shape.rewrites).toBeUndefined();
    expect(shape.redirects).toBeUndefined();
    expect(shape.headers).toBeUndefined();
  });

  it('ningún fuente de apps/web lee API_INTERNAL_URL', () => {
    const offenders = sourceFiles(webRoot)
      .filter((file) => readFileSync(file, 'utf8').includes('API_INTERNAL_URL'))
      .map((file) => relative(webRoot, file));
    expect(offenders).toEqual([]);
  });

  it('la API se llama por NEXT_PUBLIC_API_URL absoluta, nunca por una ruta relativa /api/v1 del propio sitio', () => {
    const offenders = sourceFiles(webRoot)
      .filter((file) => /['"`]\/api\/v1/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(webRoot, file));
    expect(offenders).toEqual([]);
  });
});
