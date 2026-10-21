import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OTP_AUTOFILL_CHECKS_MS, acceptOtpInput, isUserInsertion, sanitizeOtp } from '../lib/otp';

/*
 * Regresiones de fix/ui-reserva-y-mfa:
 * - El paso del código MFA se autorrellenaba con el correo guardado por el navegador (visto en Safari) y,
 *   con un usuario oculto delante (fix/mfa-safari-autofill), con la contraseña.
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

  it('no hay ningún campo de usuario (ni oculto): Safari lo tomaba por un login y metía la contraseña en el código', () => {
    const all = inputs(step);
    expect(all).toHaveLength(1);
    for (const input of all) {
      expect(input).not.toMatch(/autoComplete="(username|current-password|email)"/);
      expect(input).not.toMatch(/name="username"/);
      expect(input).not.toMatch(/type="(email|password)"/);
    }
    expect(step).not.toMatch(/autofill-username|mfa-username/);
    expect(globals).not.toMatch(/\.autofill-username/);
  });

  it('el campo del código no lo tratan como contraseña los gestores ni lo corrige el navegador', () => {
    expect(otp).toMatch(/id="otp"/);
    expect(otp).toMatch(/autoCapitalize="off"/);
    expect(otp).toMatch(/autoCorrect="off"/);
    expect(otp).toMatch(/spellCheck=\{false\}/);
    expect(otp).toMatch(/data-1p-ignore/);
    expect(otp).toMatch(/data-lpignore="true"/);
  });

  it('solo acepta el valor tras interacción real: keydown, paste, pointerdown/click y beforeinput de usuario', () => {
    expect(otp).toMatch(/ref=\{otpRef\}/);
    expect(otp).toMatch(/onKeyDown=\{markInteracted\}/);
    expect(otp).toMatch(/onPaste=\{markInteracted\}/);
    expect(otp).toMatch(/onPointerDown=\{markInteracted\}/);
    expect(otp).toMatch(/onClick=\{markInteracted\}/);
    expect(otp).toMatch(/acceptOtpInput\(event\.target\.value, userInteracted\.current\)/);
    expect(login).toMatch(/addEventListener\('beforeinput'/);
    expect(login).toMatch(/isUserInsertion\(\(event as InputEvent\)\.inputType\)/);
  });

  it('al mostrar el paso 2 reinicia la interacción y vacía estado y DOM en cada comprobación; limpia timers al desmontar', () => {
    const effect = login.match(/useEffect\(\(\) => \{\s*if \(!pendingToken\) return;[\s\S]*?\}, \[pendingToken\]\)/)?.[0];
    expect(effect).toBeDefined();
    expect(effect).toMatch(/userInteracted\.current = false/);
    expect(effect).toMatch(/OTP_AUTOFILL_CHECKS_MS\.map/);
    expect(effect).toMatch(/current\.value = ''/);
    expect(effect).toMatch(/setCode\(''\)/);
    expect(effect).toMatch(/clearTimeout/);
    expect(effect).toMatch(/removeEventListener\('beforeinput'/);
    expect(login).toMatch(/function backToPasswordStep[\s\S]*?userInteracted\.current = false/);
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

describe('acceptOtpInput / isUserInsertion: el autorrelleno sin interacción se borra', () => {
  /** Simula el campo: el flag de interacción como en la página y el valor que acaba en el estado. */
  function field() {
    let interacted = false;
    let code = '';
    return {
      interact: () => { interacted = true; },
      beforeInput: (inputType: string) => { if (isUserInsertion(inputType)) interacted = true; },
      input: (value: string) => { code = acceptOtpInput(value, interacted); return code; },
    };
  }

  it('un valor autorrellenado sin interacción (contraseña, correo o código) se descarta', () => {
    const f = field();
    expect(f.input('Contrasena-Ficticia-1')).toBe('');
    expect(f.input('ana.ficticia@example.test')).toBe('');
    expect(f.input('123456')).toBe('');
    // El autorrelleno no genera beforeinput de usuario.
    f.beforeInput('insertReplacementText');
    expect(f.input('Contrasena-Ficticia-1')).toBe('');
  });

  it('tras keydown, paste o pulsar el campo se conserva lo que escribe la persona', () => {
    const typed = field();
    typed.interact(); // keydown
    expect(typed.input('123456')).toBe('123456');

    const pasted = field();
    pasted.beforeInput('insertFromPaste');
    expect(pasted.input('654321')).toBe('654321');

    const written = field();
    written.beforeInput('insertText');
    expect(written.input('1')).toBe('1');
  });

  it('los códigos de recuperación funcionan tras la interacción, y el "@" se sigue descartando', () => {
    const f = field();
    f.interact();
    for (const value of ['abcd-ef12-3', 'ABCDE-12345', 'a1b2c3d4e5f']) expect(f.input(value)).toBe(value);
    expect(f.input('ana.ficticia@example.test')).toBe('');
  });

  it('solo escribir y pegar cuentan como inserción de usuario', () => {
    expect(isUserInsertion('insertText')).toBe(true);
    expect(isUserInsertion('insertFromPaste')).toBe(true);
    expect(isUserInsertion('insertReplacementText')).toBe(false);
    expect(isUserInsertion(undefined)).toBe(false);
  });

  it('las comprobaciones cubren desde el montaje hasta 3 s después', () => {
    expect([...OTP_AUTOFILL_CHECKS_MS]).toEqual([0, 100, 300, 700, 1500, 3000]);
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
