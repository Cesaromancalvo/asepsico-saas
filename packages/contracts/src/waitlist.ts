/**
 * Contrato de la lista de espera pública (landing estática apps/landing → API).
 * Implementación: apps/api/src/waitlist/. Guía para la landing: docs/WAITLIST_API.md.
 *
 * {API}: configurable en la landing; host a confirmar por Dora (asepsico-api.onrender.com sin verificar).
 *
 * Flujo (sin cookies, sin credenciales, fetch con mode "cors"):
 *  1. GET  {API}/api/v1/public/waitlist/form-token  → 200 WaitlistFormTokenResponse
 *     (pedirlo al abrir/enfocar el formulario, no al cargar la página).
 *  2. POST {API}/api/v1/public/waitlist  (Content-Type: application/json, body WaitlistSubmitRequest)
 *     → 202 WaitlistAcceptedResponse  (alta nueva, email repetido y honeypot: respuesta idéntica;
 *       un email repetido NO cambia nada de la alta existente)
 *     → 400 validación (NestJS: { statusCode, message: string[], error }) o WaitlistErrorResponse
 *     → 413 cuerpo > 16 KB · 415 no es application/json
 *     → 403 origen no permitido · 429 demasiados intentos desde esta IP · 5xx error del servidor
 */

export type WaitlistSituation = 'SELF_EMPLOYED' | 'PRACTICE' | 'STUDENT' | 'OTHER';
/** NOT_SAID = "Prefiero no decirlo". */
export type WaitlistSource = 'INSTAGRAM' | 'COLLEAGUE' | 'PROFESSIONAL_COLLEGE' | 'SEARCH_ENGINE' | 'OTHER' | 'NOT_SAID';

/**
 * Versión de la política que muestra (y envía) la landing. Debe estar entre las que acepta la API
 * (apps/api/src/waitlist/waitlist.config.ts, que durante la transición acepta también lista-espera-v2).
 */
export const WAITLIST_PRIVACY_POLICY_VERSION = 'lista-espera-v3';

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
  /**
   * Opcional, máx. 500. La landing manda una opción ("Doctoralia", "Eholo", "Excel / hojas de cálculo",
   * "Papel / agenda", "Nada todavía", "Otra") o "Otra: <texto>" (texto de máx. 100).
   */
  tools?: string;
  /** Opcional, entero 1–500. */
  professionalsCount?: number;
  /** Opcional. */
  source?: WaitlistSource;
  /** Debe ser exactamente true (si no, 400). */
  privacyAccepted: true;
  privacyPolicyVersion: typeof WAITLIST_PRIVACY_POLICY_VERSION;
  /**
   * La landing ya no lo envía (sin casilla de novedades); la API lo sigue aceptando y, si falta, guarda false.
   * Casilla opcional de comunicaciones comerciales. Por defecto false. Solo registra la SOLICITUD:
   * el consentimiento válido requiere doble opt-in por email (manual, fuera del formulario).
   */
  commercialConsentRequested?: boolean;
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
