/**
 * Un código de verificación válido (6 dígitos o código de recuperación de hasta 11 caracteres alfanuméricos
 * y guiones) nunca lleva "@": si lo lleva es el correo que el navegador (Safari) ha autorrellenado en el campo
 * del código, y se descarta. Cualquier otro valor se deja tal cual (la API valida el código).
 */
export function sanitizeOtp(value: string): string {
  return value.includes('@') ? '' : value;
}
