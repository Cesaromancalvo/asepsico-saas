import type { ChangePasswordRequestContract } from '@asepsico/contracts';

/** Copia de apps/api/src/auth/password-policy.ts: la API es quien decide, esto solo avisa antes de enviar. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 72;

export type ChangePasswordFields = { currentPassword: string; newPassword: string; repeatPassword: string; mfaCode?: string };
export type ChangePasswordField = 'currentPassword' | 'newPassword' | 'repeatPassword' | 'mfaCode';
export type ChangePasswordProblem = { field: ChangePasswordField; message: string };

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Primer problema del formulario (para enfocar ese campo) o null si se puede enviar. Nunca incluye las contraseñas. */
export function validateChangePassword(fields: ChangePasswordFields, mfaRequired: boolean): ChangePasswordProblem | null {
  if (!fields.currentPassword) return { field: 'currentPassword', message: 'Escribe tu contraseña actual.' };
  if ([...fields.newPassword].length < PASSWORD_MIN_LENGTH) {
    return { field: 'newPassword', message: `La nueva contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.` };
  }
  if (utf8Bytes(fields.newPassword) > PASSWORD_MAX_BYTES) {
    return {
      field: 'newPassword',
      message: `La nueva contraseña es demasiado larga (máximo ${PASSWORD_MAX_BYTES} bytes, unos ${PASSWORD_MAX_BYTES} caracteres sin tildes).`,
    };
  }
  if (fields.newPassword === fields.currentPassword) {
    return { field: 'newPassword', message: 'La nueva contraseña debe ser distinta de la actual.' };
  }
  if (fields.newPassword !== fields.repeatPassword) return { field: 'repeatPassword', message: 'Las dos contraseñas nuevas no coinciden.' };
  if (mfaRequired && !/^\d{6}$/.test(fields.mfaCode ?? '')) {
    return { field: 'mfaCode', message: 'Escribe los 6 dígitos de tu app de verificación.' };
  }
  return null;
}

/** Cuerpo de POST /auth/change-password: la repetición no se envía; el código solo si hace falta. */
export function changePasswordBody(fields: ChangePasswordFields, mfaRequired: boolean): ChangePasswordRequestContract {
  return {
    currentPassword: fields.currentPassword,
    newPassword: fields.newPassword,
    ...(mfaRequired ? { mfaCode: fields.mfaCode } : {}),
  };
}
