import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUSINESS_401_PATHS } from '@/lib/api';
import { changePasswordBody, validateChangePassword } from '@/lib/password-change';

/* Cambio de contraseña del profesional en Seguridad. Todos los valores son ficticios. */
const base = { currentPassword: 'actual-ficticia-1', newPassword: 'nueva-ficticia-123', repeatPassword: 'nueva-ficticia-123' };

describe('validateChangePassword', () => {
  it('acepta un formulario correcto sin MFA', () => {
    expect(validateChangePassword(base, false)).toBeNull();
  });

  it.each([
    ['falta la actual', { ...base, currentPassword: '' }, 'currentPassword'],
    ['nueva de 11 caracteres', { ...base, newPassword: 'a'.repeat(11), repeatPassword: 'a'.repeat(11) }, 'newPassword'],
    ['nueva de más de 72 bytes', { ...base, newPassword: 'ñ'.repeat(37), repeatPassword: 'ñ'.repeat(37) }, 'newPassword'],
    ['nueva igual a la actual', { ...base, newPassword: base.currentPassword, repeatPassword: base.currentPassword }, 'newPassword'],
    ['la repetición no coincide', { ...base, repeatPassword: 'otra-cosa-ficticia' }, 'repeatPassword'],
  ])('%s → error en el campo correcto', (_label, fields, field) => {
    expect(validateChangePassword(fields, false)?.field).toBe(field);
  });

  it('cuenta caracteres reales y bytes UTF-8: 72 bytes justos valen', () => {
    expect(validateChangePassword({ ...base, newPassword: 'a'.repeat(72), repeatPassword: 'a'.repeat(72) }, false)).toBeNull();
    expect(validateChangePassword({ ...base, newPassword: 'ñ'.repeat(36), repeatPassword: 'ñ'.repeat(36) }, false)).toBeNull();
  });

  it('con MFA exige 6 dígitos', () => {
    expect(validateChangePassword(base, true)?.field).toBe('mfaCode');
    expect(validateChangePassword({ ...base, mfaCode: '12345' }, true)?.field).toBe('mfaCode');
    expect(validateChangePassword({ ...base, mfaCode: '123456' }, true)).toBeNull();
  });

  it('los mensajes nunca incluyen las contraseñas', () => {
    const problem = validateChangePassword({ ...base, repeatPassword: 'repeticion-ficticia' }, false)!;
    for (const value of Object.values(base)) expect(problem.message).not.toContain(value);
  });
});

describe('changePasswordBody', () => {
  it('no envía la repetición y solo envía el código si hace falta', () => {
    expect(changePasswordBody({ ...base, mfaCode: '123456' }, false)).toEqual({ currentPassword: base.currentPassword, newPassword: base.newPassword });
    expect(changePasswordBody({ ...base, mfaCode: '123456' }, true)).toEqual({
      currentPassword: base.currentPassword, newPassword: base.newPassword, mfaCode: '123456',
    });
  });
});

describe('cliente de la API', () => {
  it('un 401 de /auth/change-password es de negocio: no se renueva la sesión ni se repite (contaría el fallo dos veces)', () => {
    expect(BUSINESS_401_PATHS.has('/auth/change-password')).toBe(true);
  });
});

describe('pantalla de Seguridad', () => {
  const root = join(__dirname, '..');
  const form = readFileSync(join(root, 'components', 'ChangePasswordForm.tsx'), 'utf8');
  const page = readFileSync(join(root, 'app', 'settings', 'security', 'page.tsx'), 'utf8');

  it('la página incluye el formulario de cambio de contraseña', () => {
    expect(page).toContain('<ChangePasswordForm');
  });

  it('campos de contraseña sin valor precargado y con autocomplete correcto', () => {
    const inputs = form.match(/<input\b[\s\S]*?\/>/g) ?? [];
    const passwords = inputs.filter((i) => i.includes('type="password"'));
    expect(passwords).toHaveLength(3);
    for (const input of passwords) {
      expect(input).not.toMatch(/\bdefaultValue\b|\bvalue=/);
      expect(input).toMatch(/autoComplete="(current-password|new-password)"/);
    }
    expect(form).toContain('autoComplete="one-time-code"');
  });

  it('accesible: cada campo con su etiqueta, errores con role="alert" y éxito con role="status"', () => {
    expect((form.match(/<label className="field">/g) ?? []).length).toBe(4);
    expect(form).toContain('role="alert"');
    expect(form).toContain('role="status"');
    expect(form).toContain('aria-invalid');
    expect(form).toContain('aria-describedby');
  });

  it('avisa de que se han cerrado las otras sesiones', () => {
    expect(form).toMatch(/cerrado tu sesión en los demás dispositivos/);
  });
});
