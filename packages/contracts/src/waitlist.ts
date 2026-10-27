/**
 * Contrato de la lista de espera pública (landing estática apps/landing → API).
 * Implementación: apps/api/src/waitlist/. Guía para la landing: docs/WAITLIST_API.md.
 *
 * {API}: configurable en la landing; host a confirmar por Dora (asepsico-api.onrender.com sin verificar).
 *
 * Flujo (sin cookies, sin credenciales, fetch con mode "cors"):
 *  1. GET  {API}/api/v1/public/waitlist/form-token  → 200 WaitlistFormTokenResponse
 *     (la landing lo pide al cargar la portada para despertar la API; ver docs/WAITLIST_API.md).
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
 * Política con teléfono obligatorio (27/10/2026). Con ella la landing envía `phone`. Con v2–v4 NO se
 * envía `phone` (400 WAITLIST_PHONE_NOT_INFORMED).
 */
export const WAITLIST_PHONE_POLICY_VERSION = 'lista-espera-v5';

/**
 * Versión de la política que muestra (y envía) la landing: la v5 desde el 27/10/2026. Debe estar entre
 * las que acepta la API (apps/api/src/waitlist/waitlist.config.ts, que durante la transición acepta
 * también lista-espera-v2 a v4). Orden de despliegue: API → política v5 → landing.
 */
export const WAITLIST_PRIVACY_POLICY_VERSION = 'lista-espera-v5';

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
   * Teléfono tal como lo teclea la persona (string, máx. 25 caracteres); la API lo valida y lo
   * normaliza a E.164. OBLIGATORIO con privacyPolicyVersion = 'lista-espera-v5'; NO se envía con
   * v2–v4. Se ignoran espacios, puntos, guiones y paréntesis. Se aceptan:
   *  - España: 9 dígitos de móvil (6xx, 71x–74x) o fijo geográfico (8[1-8]x, 9[1-8]x), con o sin
   *    +34 / 0034 / 34. Se rechazan 70x, 80x y 90x (tarificación especial y servicios).
   *  - Internacional: «+» o «00», prefijo distinto de 34 y 8–15 dígitos en total.
   * Errores (400 WaitlistErrorResponse): WAITLIST_PHONE_REQUIRED (v5 sin phone o vacío),
   * WAITLIST_PHONE_INVALID (formato), WAITLIST_PHONE_NOT_INFORMED (phone con v2–v4). Un phone que no
   * sea string o con más de 25 caracteres da el 400 de validación genérico (message nombra «phone»).
   */
  phone?: string;
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
  privacyPolicyVersion: typeof WAITLIST_PRIVACY_POLICY_VERSION | typeof WAITLIST_PHONE_POLICY_VERSION;
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
  /**
   * TOO_FAST: esperar minSeconds y reintentar. TOKEN_INVALID: pedir otro token y reintentar.
   * PHONE_REQUIRED / PHONE_INVALID: error junto al campo teléfono (la API no devuelve el valor).
   * PHONE_NOT_INFORMED: la landing envió phone con una política v2–v4 (error de la landing, no del usuario).
   * COMMERCIAL_NOT_OFFERED: casilla comercial con una política que no la ofrece.
   */
  code:
    | 'WAITLIST_FORM_TOO_FAST'
    | 'WAITLIST_FORM_TOKEN_INVALID'
    | 'WAITLIST_PHONE_REQUIRED'
    | 'WAITLIST_PHONE_INVALID'
    | 'WAITLIST_PHONE_NOT_INFORMED'
    | 'WAITLIST_COMMERCIAL_NOT_OFFERED';
  message: string;
}
