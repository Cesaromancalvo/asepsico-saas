/**
 * Contrato de la lista de espera pública (landing estática apps/landing → API).
 * Implementación: apps/api/src/waitlist/. Guía para la landing: docs/WAITLIST_API.md.
 *
 * Flujo (sin cookies, sin credenciales, fetch con mode "cors"):
 *  1. GET  {API}/api/v1/public/waitlist/form-token  → 200 WaitlistFormTokenResponse
 *     (pedirlo al abrir/enfocar el formulario, no al cargar la página).
 *  2. POST {API}/api/v1/public/waitlist  (Content-Type: application/json, body WaitlistSubmitRequest)
 *     → 202 WaitlistAcceptedResponse  (alta nueva, email repetido y honeypot: respuesta idéntica)
 *     → 400 validación (NestJS: { statusCode, message: string[], error }) o WaitlistErrorResponse
 *     → 403 origen no permitido · 429 demasiados intentos desde esta IP · 5xx error del servidor
 */

export type WaitlistSituation = 'SELF_EMPLOYED' | 'PRACTICE' | 'STUDENT' | 'OTHER';
export type WaitlistSource = 'INSTAGRAM' | 'COLLEAGUE' | 'PROFESSIONAL_COLLEGE' | 'SEARCH_ENGINE' | 'OTHER';

/** Versión de la política que muestra la landing. Debe coincidir con la que acepta la API. */
export const WAITLIST_PRIVACY_POLICY_VERSION = 'lista-espera-v2';

export interface WaitlistFormTokenResponse {
  formToken: string;
  /** Segundos mínimos entre pedir el token y enviar el formulario. */
  minSeconds: number;
}

export interface WaitlistSubmitRequest {
  /** 2–120 caracteres. */
  name: string;
  /** Email válido, máx. 254. */
  email: string;
  situation: WaitlistSituation;
  /** Opcional, máx. 500. */
  tools?: string;
  /** Opcional, entero 1–500. */
  professionalsCount?: number;
  source: WaitlistSource;
  /** Debe ser exactamente true (si no, 400). */
  privacyAccepted: true;
  privacyPolicyVersion: typeof WAITLIST_PRIVACY_POLICY_VERSION;
  /** Casilla opcional de comunicaciones comerciales. Por defecto false. */
  commercialConsent?: boolean;
  /** El de GET /form-token. */
  formToken: string;
  /** Honeypot: input oculto (no display:none ni type=hidden), siempre vacío para un humano. */
  website?: string;
}

export interface WaitlistAcceptedResponse {
  status: 'accepted';
}

export interface WaitlistErrorResponse {
  statusCode: 400;
  /** TOO_FAST: esperar minSeconds y reintentar. TOKEN_INVALID: pedir otro token y reintentar. */
  code: 'WAITLIST_FORM_TOO_FAST' | 'WAITLIST_FORM_TOKEN_INVALID';
  message: string;
}
