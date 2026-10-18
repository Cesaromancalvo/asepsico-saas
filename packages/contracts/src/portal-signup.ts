// Alta en el portal con el QR fijo del profesional (docs/producto/whatsapp-y-alta-qr.md, Parte B
// rediseñada el 18/10/2026). Contrato entre apps/api (módulo portal-signup) y apps/web.

/** GET /portal-intake-links/:professionalId y POST .../rotate (":professionalId" puede ser "me"). */
export interface PortalIntakeLinkContract {
  professionalId: string;
  exists?: boolean;
  isActive: boolean;
  rotatedAt: string | null;
  /** Token del QR (43 caracteres). null si está desactivado. Recomendado en el fragmento: /portal/alta#t=<token>. */
  token: string | null;
}

/** POST /public/portal-signup/requests (público, 202). Las casillas se muestran desmarcadas. */
export interface PortalSignupRequestBody {
  token: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  /** AAAA-MM-DD, obligatoria. Menores de 16 → 400 PORTAL_SIGNUP_MIN_AGE. */
  birthDate: string;
  /** "He leído la información sobre cómo se tratan mis datos." Acuse de lectura, no consentimiento. */
  privacyNoticeAcknowledged: true;
  /** "Acepto las normas de uso del portal." */
  portalTermsAccepted: true;
  privacyNoticeVersion: string;
  portalTermsVersion: string;
}

/** Respuesta única del envío público (no revela si el QR existe ni de quién es). */
export interface PortalSignupAcceptedResponse { ok: true; message: string }

/** GET /portal-signup-requests: solicitudes PENDIENTES (descifradas para quien revisa). */
export interface PortalSignupRequestContract {
  id: string;
  professionalId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  birthDate: string;
  createdAt: string;
  expiresAt: string;
}

/** POST /portal-signup-requests/:id/link | /create-patient y POST /patients/:id/portal-account/activation-link. */
export interface PortalSignupAcceptedContract {
  patientId?: string;
  portalAccountId: string;
  /** Se muestra UNA vez a la consulta (QR o enlace) para que el paciente ponga su contraseña. Caduca a las 72 h. */
  activation: { token: string; expiresAt: string };
}

/** POST /public/portal-signup/activate (público). Error genérico: 400 PORTAL_ACTIVATION_INVALID. */
export interface PortalActivationBody { token: string; password: string }

export type PortalSignupErrorCode =
  | 'PORTAL_SIGNUP_MIN_AGE'
  | 'PORTAL_SIGNUP_MANUAL_WITH_GUARDIAN'
  | 'PORTAL_SIGNUP_IDENTITY_MISMATCH'
  | 'PORTAL_ACCOUNT_ALREADY_EXISTS'
  | 'PORTAL_ACTIVATION_INVALID';
