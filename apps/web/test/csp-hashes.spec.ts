import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* postbuild del export: meta CSP con el sha256 de cada script inline (sin 'unsafe-inline' efectivo). */
const SCRIPT = join(__dirname, '..', 'scripts', 'csp-hashes.mjs');
const hash = (t: string) => `'sha256-${createHash('sha256').update(t, 'utf8').digest('base64')}'`;
const run = (dir: string) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

describe('scripts/csp-hashes.mjs', () => {
  it('escribe una meta CSP por página con los hashes de sus scripts inline, y es idempotente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-'));
    try {
      mkdirSync(join(dir, 'login'));
      const a = 'self.__next_f.push([1,"a"])', b = 'self.__next_f.push([1,"b"])';
      writeFileSync(join(dir, 'login', 'index.html'), `<!DOCTYPE html><html><head><meta charSet="utf-8"/><script src="/_next/x.js" async=""></script></head><body><script>${a}</script><script>${b}</script><script type="application/json">{"no":"js"}</script></body></html>`);
      expect(run(dir).status).toBe(0);
      const once = readFileSync(join(dir, 'login', 'index.html'), 'utf8');
      const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"\/>/.exec(once)?.[1] ?? '';
      expect(meta).toBe(`script-src 'self' ${hash(a)} ${hash(b)}; object-src 'none'; base-uri 'self'`);
      expect(meta).not.toContain('unsafe-inline');
      expect(once.indexOf('Content-Security-Policy')).toBeLessThan(once.indexOf('<script'));
      expect(run(dir).status).toBe(0);
      expect(readFileSync(join(dir, 'login', 'index.html'), 'utf8')).toBe(once);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falla cerrado si una página con scripts inline no puede llevar la meta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<html><head></head><body><script>alert(1)</script></body></html>');
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('FALLO');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
