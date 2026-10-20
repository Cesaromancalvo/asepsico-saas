import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeOtp } from '../lib/otp';

/*
 * Regresiones de fix/ui-reserva-y-mfa:
 * - El paso del código MFA se autorrellenaba con el correo guardado por el navegador (visto en Safari).
 * - La regla .bk-switch input (22x22) deformaba el interruptor .e1-switch de "Reserva desde el portal".
 */
const WEB_ROOT = join(__dirname, '..');
const login = readFileSync(join(WEB_ROOT, 'app', 'login', 'page.tsx'), 'utf8');
const designSystem = readFileSync(join(WEB_ROOT, 'app', 'design-system.css'), 'utf8');
const globals = readFileSync(join(WEB_ROOT, 'app', 'globals.css'), 'utf8');

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

  it('el usuario oculto va antes del código y está oculto solo a la vista (Safari ignora hidden/display:none)', () => {
    const all = inputs(step);
    const userIndex = all.findIndex((input) => /autoComplete="username"/.test(input));
    const otpIndex = all.findIndex((input) => /name="otp"/.test(input));
    expect(userIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeLessThan(otpIndex);
    const user = all[userIndex];
    expect(user).toMatch(/name="username"/);
    expect(user).toMatch(/id="mfa-username"/);
    expect(user).toMatch(/value=\{email\}/);
    expect(user).toMatch(/readOnly/);
    expect(user).toMatch(/tabIndex=\{-1\}/);
    expect(user).toMatch(/aria-hidden="true"/);
    expect(user).toMatch(/className="sr-only autofill-username"/);
    // Ni el atributo hidden ni display:none: Safari no autorrellena campos ocultos así y mete el correo en el código.
    expect(user).not.toMatch(/(?<![-\w])hidden\b/); // aria-hidden sí, el atributo hidden no
    expect(user).not.toMatch(/display:\s*'?none/);
  });

  it('la clase del usuario oculto lo saca de la vista sin display:none ni visibility:hidden', () => {
    expect(globals).toMatch(/\.sr-only\{position:absolute;width:1px;height:1px;[^}]*overflow:hidden;clip:rect\(0,0,0,0\)/);
    const rule = globals.match(/\.autofill-username\{[^}]*\}/)?.[0];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/opacity:0/);
    expect(rule).toMatch(/pointer-events:none/);
    expect(rule).not.toMatch(/display:none|visibility:hidden/);
  });

  it('el campo del código tiene id="otp" y descarta el correo autorrellenado (al escribir, al enfocar y al montar)', () => {
    expect(otp).toMatch(/id="otp"/);
    expect(otp).toMatch(/onChange=\{\(event\) => setCode\(sanitizeOtp\(event\.target\.value\)\)\}/);
    expect(otp).toMatch(/onFocus=/);
    expect(otp).toMatch(/ref=\{otpRef\}/);
    expect(login).toMatch(/useEffect\(\(\) => \{\s*if \(!pendingToken\) return;[\s\S]*?sanitizeOtp[\s\S]*?\}, \[pendingToken\]\)/);
  });

  it('el código enviado a /auth/login/mfa es el del estado, no un campo "code" del formulario', () => {
    expect(login).toMatch(/JSON\.stringify\(\{ pendingToken, code \}\)/);
    expect(login).not.toMatch(/namedItem\('code'\)/);
  });
});

describe('sanitizeOtp: limpia el correo autorrellenado sin tocar códigos válidos', () => {
  it('vacía cualquier valor con "@"', () => {
    expect(sanitizeOtp('ana.ficticia@example.test')).toBe('');
    expect(sanitizeOtp('@')).toBe('');
  });

  it('respeta códigos TOTP y de recuperación (hasta 11 caracteres alfanuméricos y guiones)', () => {
    for (const value of ['', '123456', '12345', 'abcd-ef12-3', 'ABCDE-12345', 'a1b2c3d4e5f']) {
      expect(sanitizeOtp(value)).toBe(value);
    }
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
