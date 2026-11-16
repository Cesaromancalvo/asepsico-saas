import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/*
 * La web no puede importar código de apps/api. `next build` revisa los tipos de todo lo que incluye
 * el tsconfig (también test/**) y, por un import así, acaba revisando la API, que necesita el
 * cliente de Prisma generado. En Render el build de la web no lo genera y falla
 * («Property 'sql' does not exist on type 'typeof Prisma'», 16/11). Si la web necesita algo de la
 * API, va a packages/contracts o se copia con un comentario que diga de dónde sale.
 */
const WEB = resolve(__dirname, '..');
const API = resolve(WEB, '..', 'api');
const SKIP = new Set(['node_modules', '.next', 'out', 'public']);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// import … from '…', export … from '…', import '…', import('…'), require('…')
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return SOURCE.test(name) ? [path] : [];
  });
}

function importsApi(file: string, spec: string): boolean {
  if (/^@asepsico\/api(\/|$)/.test(spec) || /(^|\/)apps\/api(\/|$)/.test(spec)) return true;
  if (!spec.startsWith('.')) return false;
  const target = resolve(file, '..', spec);
  return target === API || target.startsWith(API + sep);
}

describe('apps/web no importa código de apps/api', () => {
  it('ningún archivo de la web importa rutas de la API', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB)) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
        if (importsApi(file, spec)) offenders.push(`${relative(WEB, file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('la comprobación detecta un import a la API (el que rompió Render)', () => {
    const file = join(WEB, 'test', 'ejemplo.spec.tsx');
    // Ruta troceada para que este archivo no se detecte a sí mismo.
    const bad = ['..', '..', 'api', 'src', 'notifications', 'appointment-change-notice.util'].join('/');
    const sample = `import { renderAppointmentChange } from '${bad}';`;
    const specs = [...sample.matchAll(SPECIFIER)].map((m) => m[1]);
    expect(specs).toEqual([bad]);
    expect(importsApi(file, specs[0])).toBe(true);
    expect(importsApi(join(WEB, 'app', 'page.tsx'), '../lib/api')).toBe(false);
    expect(importsApi(file, '@asepsico/contracts')).toBe(false);
  });
});
