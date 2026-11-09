import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Pendiente de Quima/Argos (08/11): ninguna dirección del dominio de pruebas
 * (@pruebas.asepsico.es) fuera de apps/api/test/: ni en el código (src de api, web y contracts),
 * ni en los seeds y scripts de prisma, ni en los .env.example. Ese dominio es solo para los tests;
 * si llegara al código o a un seed, se usaría como destinatario fuera del entorno de pruebas.
 *
 * Quedan fuera, a propósito: la cuenta demo del seed (demo@asepsico.es, usada en CI, smoke y
 * documentación) y el remitente único de AsePsico (decisión del Jefe del 07/11).
 */

const REPO = join(__dirname, '..', '..', '..');
const SCAN_DIRS = ['apps/api/src', 'apps/api/prisma', 'apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages/contracts/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'out', 'build', 'coverage', 'migrations']);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|txt|html|css|ya?ml)$/;
// @pruebas.asepsico.es, y que el dominio termine ahí (no x@pruebas.asepsico.es.example.com).
const ADDRESS = /[A-Za-z0-9._%+-]+@pruebas\.asepsico\.es(?![A-Za-z0-9-]|\.[A-Za-z0-9])/gi;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Los .env.example del monorepo (raíz y workspaces), sin entrar en node_modules. */
function envExamples(): string[] {
  const candidates = ['.env.example', 'apps/api/.env.example', 'apps/web/.env.example', 'apps/landing/.env.example', 'packages/contracts/.env.example'];
  return candidates.map((c) => join(REPO, c)).filter((f) => existsSync(f));
}

function scannedFiles(): string[] {
  return [...SCAN_DIRS.flatMap((d) => walk(join(REPO, d))).filter((f) => TEXT_EXT.test(f)), ...envExamples()];
}

function findings() {
  const out: Array<{ file: string; line: number; address: string }> = [];
  for (const full of scannedFiles()) {
    const file = relative(REPO, full).split('\\').join('/');
    if (file.startsWith('apps/api/test/')) continue;
    readFileSync(full, 'utf8').split('\n').forEach((text, i) => {
      for (const m of text.matchAll(ADDRESS)) out.push({ file, line: i + 1, address: m[0].toLowerCase() });
    });
  }
  return out;
}

describe('Sin direcciones del dominio de pruebas (@pruebas.asepsico.es) fuera de apps/api/test/', () => {
  it('el escaneo cubre código, seeds y .env.example, y no apps/api/test (control)', () => {
    const files = scannedFiles().map((f) => relative(REPO, f).split('\\').join('/'));
    expect(files).toEqual(expect.arrayContaining(['.env.example', 'apps/api/prisma/seed.ts', 'apps/api/prisma/seed-guard.ts']));
    expect(files.some((f) => f.startsWith('apps/api/src/'))).toBe(true);
    expect(files.some((f) => f.startsWith('apps/web/app/'))).toBe(true);
    expect(files.some((f) => f.startsWith('packages/contracts/src/'))).toBe(true);
    expect(files.some((f) => f.startsWith('apps/api/test/'))).toBe(false);
  });

  it('el patrón detecta el dominio de pruebas y no otros (control)', () => {
    const match = (s: string) => [...s.matchAll(ADDRESS)].map((m) => m[0].toLowerCase());
    expect(match("const a = 'persona.ficticia@pruebas.asepsico.es';")).toEqual(['persona.ficticia@pruebas.asepsico.es']);
    expect(match('MAIL_TO=Avisos@Pruebas.AsePsico.es.')).toEqual(['avisos@pruebas.asepsico.es']);
    expect(match('demo@asepsico.es, avisos@notificaciones.asepsico.es, x@example.com, y@pruebas.asepsico.es.example.com')).toEqual([]);
  });

  it('ninguna dirección @pruebas.asepsico.es en src, seeds ni .env.example', () => {
    expect(findings()).toEqual([]);
  });
});
