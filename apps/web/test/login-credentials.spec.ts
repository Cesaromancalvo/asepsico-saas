import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Veto de Argos: la pantalla de login mostraba en producción las credenciales de la cuenta demo
 * (texto "Demo: …" y defaultValue en correo y contraseña). Ni el login ni ninguna otra pantalla
 * pueden volver a llevarlas, ni detrás de una variable de entorno.
 */
const WEB_ROOT = join(__dirname, '..');
const LOGIN_PAGE = join(WEB_ROOT, 'app', 'login', 'page.tsx');
const LEAKED_PASSWORD = 'AsePsico2026!';
const DEMO_EMAIL = 'demo@asepsico.es';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '.next' || entry === 'test') return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?|mjs|json|md|html)$/.test(entry) ? [full] : [];
  });
}

describe('login sin credenciales precargadas', () => {
  const login = readFileSync(LOGIN_PAGE, 'utf8');

  it('no contiene la contraseña de la cuenta demo', () => {
    expect(login).not.toContain(LEAKED_PASSWORD);
  });

  it('el campo de contraseña no lleva defaultValue ni value', () => {
    const passwordInputs = login.match(/<input\b[^>]*type="password"[^>]*>/g) ?? [];
    expect(passwordInputs.length).toBeGreaterThan(0);
    for (const input of passwordInputs) {
      expect(input).not.toMatch(/\bdefaultValue\b/);
      expect(input).not.toMatch(/\bvalue=/);
    }
  });

  it('el campo de correo no viene precargado y no hay texto "Demo:"', () => {
    const emailInputs = login.match(/<input\b[^>]*type="email"[^>]*>/g) ?? [];
    for (const input of emailInputs) expect(input).not.toMatch(/\bdefaultValue\b/);
    expect(login).not.toMatch(/Demo:/);
    expect(login).not.toContain(DEMO_EMAIL);
  });

  it('ningún archivo de apps/web contiene las credenciales de la cuenta demo', () => {
    const offenders = sourceFiles(WEB_ROOT).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes(LEAKED_PASSWORD) || text.includes(DEMO_EMAIL);
    });
    expect(offenders).toEqual([]);
  });
});
