/**
 * Un código de verificación válido (6 dígitos o código de recuperación de hasta 11 caracteres alfanuméricos
 * y guiones) nunca lleva "@": si lo lleva es el correo que el navegador ha autorrellenado en el campo
 * del código, y se descarta. Cualquier otro valor se deja tal cual (la API valida el código).
 */
export function sanitizeOtp(value: string): string {
  return value.includes('@') ? '' : value;
}

/**
 * Valor que se acepta en el campo del código. Hasta que la persona interactúa de verdad con el campo
 * (tecla, pegar, pulsar o tocar) cualquier valor lo ha puesto el navegador o un gestor de contraseñas
 * (Safari llegó a meter el correo y luego la contraseña) y se descarta.
 */
export function acceptOtpInput(value: string, userInteracted: boolean): string {
  return userInteracted ? sanitizeOtp(value) : '';
}

/** `beforeinput` que solo produce una persona: escribir o pegar. El autorrelleno no los genera. */
export function isUserInsertion(inputType: string | undefined): boolean {
  return inputType === 'insertText' || inputType === 'insertFromPaste';
}

/** Momentos (ms tras mostrar el paso 2) en que se vacía lo que haya escrito el navegador sin interacción. */
export const OTP_AUTOFILL_CHECKS_MS = [0, 100, 300, 700, 1500, 3000] as const;
