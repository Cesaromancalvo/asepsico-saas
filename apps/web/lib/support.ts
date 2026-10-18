/**
 * Soporte, fase 0 (docs/producto/mejoras-salida-y-confianza.md, historia S0): un buzón y un compromiso
 * informativo. Los textos viven aquí para que la pantalla y la prueba lean lo mismo.
 */
export const SUPPORT_EMAIL = 'asepsico1@gmail.com';
export const STATUS_URL = 'https://asepsico.es/estado/';
export const CHANGES_URL = 'https://asepsico.es/cambios/';

export const SUPPORT_NO_PATIENT_DATA = 'No incluyas datos de pacientes.';
export const SUPPORT_NO_PATIENT_DATA_DETAIL =
  'Ni nombres, ni motivos de consulta, ni capturas de pantalla con datos reales. Tampoco nos envíes nunca tu contraseña ni un código de verificación.';

export const SUPPORT_COMMITMENT = [
  'Te respondemos en 1 día laborable (de lunes a viernes, sin festivos nacionales). Es un plazo de primera respuesta, no de solución del problema.',
  'Si no puedes trabajar (no puedes entrar o la agenda no funciona), usa el botón «No puedo trabajar»: lo vemos antes que el resto.',
];
export const SUPPORT_DISCLAIMER =
  'Este plazo es el de las condiciones de la prueba del piloto; no se aplica a otros casos.';

export const SUPPORT_SUBJECT = 'Consulta sobre AsePsico';
export const SUPPORT_SUBJECT_BLOCKED = 'No puedo trabajar con AsePsico';

export function supportMailto(subject: string): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}
