import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

/**
 * Política de contraseña de los profesionales al CAMBIARLA desde la app.
 * - Mínimo 12 caracteres: el mismo que el registro (RegisterDto / RegisterMemberDto).
 * - Máximo 72 bytes UTF-8: bcrypt ignora lo que pase de ahí, así que una contraseña más larga
 *   daría una falsa sensación de seguridad (mismo criterio que el CLI users:set-password).
 * Copia de los valores en apps/web/lib/password-change.ts.
 */
export const STAFF_PASSWORD_MIN_LENGTH = 12;
export const STAFF_PASSWORD_MAX_BYTES = 72;
/** Mismo coste que el alta (registration.service.ts) y el CLI. */
export const STAFF_BCRYPT_COST = 12;

/** Máximo en bytes UTF-8 (no en caracteres: una tilde o un emoji ocupan más de un byte). */
export function MaxUtf8Bytes(max: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'maxUtf8Bytes',
      constraints: [max],
      validator: {
        validate: (value: unknown) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max,
        defaultMessage: buildMessage((prefix) => `${prefix}$property no puede ocupar más de $constraint1 bytes`, options),
      },
    },
    options,
  );
}

/** Mínimo en caracteres reales (puntos de código), no en unidades UTF-16. */
export function MinChars(min: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'minChars',
      constraints: [min],
      validator: {
        validate: (value: unknown) => typeof value === 'string' && [...value].length >= min,
        defaultMessage: buildMessage((prefix) => `${prefix}$property debe tener al menos $constraint1 caracteres`, options),
      },
    },
    options,
  );
}
