import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Regresiones de fix/ui-reserva-y-mfa:
 * - El paso del código MFA se autorrellenaba con el correo guardado por el navegador.
 * - La regla .bk-switch input (22x22) deformaba el interruptor .e1-switch de "Reserva desde el portal".
 */
const WEB_ROOT = join(__dirname, '..');
const login = readFileSync(join(WEB_ROOT, 'app', 'login', 'page.tsx'), 'utf8');
const designSystem = readFileSync(join(WEB_ROOT, 'app', 'design-system.css'), 'utf8');

/** Bloque JSX del paso 2 (lo que se pinta cuando hay pendingToken). */
function mfaStep(): string {
  const start = login.indexOf('if (pendingToken)');
  expect(start).toBeGreaterThan(-1);
  const end = login.indexOf('</form>', start);
  expect(end).toBeGreaterThan(start);
  return login.slice(start, end);
}

function inputs(source: string): string[] {
  return source.match(/<input\b[\s\S]*?\/>/g) ?? [];
}

describe('login: paso del código de verificación en dos pasos', () => {
  const step = mfaStep();
  const otp = inputs(step).find((input) => /name="otp"/.test(input));

  it('el campo del código se llama otp y pide one-time-code', () => {
    expect(otp).toBeDefined();
    expect(otp).toMatch(/autoComplete="one-time-code"/);
    expect(otp).toMatch(/type="text"/);
    expect(otp).toMatch(/inputMode="numeric"/);
  });

  it('ningún input del paso 2 se llama "code" ni "email" (no se autorrellena con el correo)', () => {
    for (const input of inputs(step)) {
      expect(input).not.toMatch(/name="code"/);
      expect(input).not.toMatch(/name="email"/);
      expect(input).not.toMatch(/autoComplete="email"/);
    }
  });

  it('el código empieza vacío: controlado con un estado inicial vacío y se limpia al entrar al paso 2', () => {
    expect(otp).toMatch(/value=\{code\}/);
    expect(otp).not.toMatch(/\bdefaultValue\b/);
    expect(login).toMatch(/const \[code, setCode\] = useState\(''\)/);
    // Al recibir mfaRequired se vacía antes de mostrar el paso 2.
    expect(login).toMatch(/if \(result\.mfaRequired\) \{\s*setCode\(''\);\s*setPendingToken/);
    // Y al volver al paso 1.
    expect(login).toMatch(/function backToPasswordStep[\s\S]*?setCode\(''\)/);
  });

  it('existe el usuario oculto con autocomplete="username" para los gestores de contraseñas', () => {
    const hidden = inputs(step).find((input) => /autoComplete="username"/.test(input));
    expect(hidden).toBeDefined();
    expect(hidden).toMatch(/\bhidden\b/);
    expect(hidden).toMatch(/readOnly/);
    expect(hidden).toMatch(/tabIndex=\{-1\}/);
    expect(hidden).not.toMatch(/name="otp"/);
  });

  it('el código enviado a /auth/login/mfa es el del estado, no un campo "code" del formulario', () => {
    expect(login).toMatch(/JSON\.stringify\(\{ pendingToken, code \}\)/);
    expect(login).not.toMatch(/namedItem\('code'\)/);
  });
});

describe('interruptor "Reserva desde el portal"', () => {
  it('la regla .bk-switch input que deformaba .e1-switch ya no existe', () => {
    expect(designSystem).not.toMatch(/\.bk-switch\s+input\s*\{/);
    expect(designSystem).not.toMatch(/\.bk-switch input\{width:22px/);
  });

  it('.bk-switch no redefine tamaño ni accent-color del input', () => {
    const rules = designSystem.match(/\.bk-switch[^{]*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).not.toMatch(/accent-color/);
      expect(rule).not.toMatch(/width:22px|height:22px/);
    }
  });
});
