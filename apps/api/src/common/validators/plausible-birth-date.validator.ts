import { registerDecorator, ValidationOptions } from 'class-validator';

const MAX_AGE_YEARS = 120;

/** Misma regla que el alta manual: fecha real, no futura y de menos de 120 años. */
export function isPlausibleBirthDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  const now = new Date();
  const minDate = new Date(
    now.getFullYear() - MAX_AGE_YEARS,
    now.getMonth(),
    now.getDate()
  );

  return date <= now && date >= minDate;
}

export function IsPlausibleBirthDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPlausibleBirthDate',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isPlausibleBirthDate(value);
        },

        defaultMessage() {
          return `birthDate debe ser una fecha real, no futura y de menos de ${MAX_AGE_YEARS} años`;
        },
      },
    });
  };
}
