export type PatientStatus = 'ACTIVE' | 'PAUSED' | 'DISCHARGED' | 'ARCHIVED';
export interface PatientContract { id:string; workspaceId:string; firstName:string; lastName:string; email?:string|null; phone?:string|null; status:PatientStatus; createdAt:string; updatedAt:string; }

// --- Agenda y citas entre profesionales (decisión del 02/10) ---------------------------------

export type SessionStatusValue = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
export interface ProfessionalRef { id: string; firstName: string; lastName: string }

/**
 * Cita de otro profesional vista por un clínico que trata al paciente: solo cuándo y con quién.
 * Siempre es una cita programada y futura (por eso no lleva estado). También es la forma de cada
 * cita del 409 PROCESS_HAS_FUTURE_SESSIONS.
 */
export interface BusySessionContract {
  id: string;
  patientId: string;
  startsAt: string;
  endsAt: string;
  therapist: ProfessionalRef | null;
}

/** Cita con metadatos de agenda (las propias, o todas en la vista administrativa). Sin notas. */
export interface FullAgendaSessionContract extends BusySessionContract {
  status: SessionStatusValue;
  workspaceId: string;
  therapistId: string;
  clinicalProcessId: string | null;
  type: string;
  location: string | null;
  videoCallUrl: string | null;
  createdAt: string;
  updatedAt: string;
  patient: { id: string; firstName: string; lastName: string } | null;
  clinicalProcess: { id: string; modality: string; status: string } | null;
}

export type PatientAgendaItem =
  | (FullAgendaSessionContract & { visibility: 'FULL' })
  | (BusySessionContract & { visibility: 'BUSY' });

/** GET /sessions/patient/:patientId/agenda */
export interface PatientAgendaResponse {
  patientId: string;
  /** TREATING: THERAPIST que trata al paciente. ADMINISTRATIVE: OWNER, ADMIN y ASSISTANT. */
  view: 'TREATING' | 'ADMINISTRATIVE';
  data: PatientAgendaItem[];
  /** Próxima cita SCHEDULED del paciente con cualquier profesional (o null). */
  nextSession: PatientAgendaItem | null;
}

/** PATCH /clinical-processes/:id/status */
export interface ChangeClinicalProcessStatusRequest {
  status: 'ACTIVE' | 'PAUSED' | 'DISCHARGED' | 'CLOSED';
  /** Cancela en la misma transacción las citas futuras programadas del proceso. */
  cancelFutureSessions?: boolean;
}

export const PROCESS_HAS_FUTURE_SESSIONS = 'PROCESS_HAS_FUTURE_SESSIONS';

/** Cuerpo del 409 al cerrar o dar de alta un proceso con citas futuras programadas. */
export interface ProcessHasFutureSessionsError {
  statusCode: 409;
  error: 'Conflict';
  code: typeof PROCESS_HAS_FUTURE_SESSIONS;
  message: string;
  sessions: BusySessionContract[];
}

/** Fila de GET /messages (bandeja): `therapist` es el profesional del proceso activo. */
export interface ConversationListItemContract {
  id: string;
  status: string;
  patientCanReply: boolean;
  closedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  patient: { id: string; firstName: string; lastName: string; status: string };
  /** null si no hay proceso activo o si el THERAPIST que consulta no trata al paciente. */
  therapist: ProfessionalRef | null;
  canReadMessages: boolean;
  unreadCount: number | null;
  messages: Array<{ id: string; body: string; senderType: string; createdAt: string; readByProfessionalAt: string | null; readByPatientAt: string | null }>;
}

export * from './patient-import';
export * from './waitlist';

// Registro por invitación y condiciones versionadas (feat/registro-por-invitacion).
export type LegalDocumentType = 'PILOT_TERMS' | 'DPA_ART28' | 'PRIVACY_PRODUCT';
/** GET /legal/terms (público). `draft` = el texto aún tiene algún marcador sin rellenar ([NIF], [PENDIENTE DEL DESPACHO]...). En el piloto demo los vigentes son PILOT_TERMS y PRIVACY_PRODUCT. */
export interface LegalDocumentContract { documentType: LegalDocumentType; version: string; title: string; textHash: string; draft: boolean; text: string; }
/** Lo que el cliente envía al aceptar: exactamente lo que recibió en GET /legal/terms. */
export interface AcceptedTermContract { documentType: LegalDocumentType; version: string; textHash: string; }
/** GET /legal/terms/status y respuesta de POST /legal/terms/accept. Cada profesional acepta por sí mismo: canAccept es true para cualquier miembro. */
export interface TermsStatusContract { acceptanceRequired: boolean; canAccept: boolean; pending: Omit<LegalDocumentContract, 'text'>[]; }
/** Códigos de error estables. 428 TERMS_ACCEPTANCE_REQUIRED lo devuelve cualquier ruta a un profesional (titular o miembro) con condiciones pendientes. */
export type RegistrationErrorCode = 'REGISTRATION_NOT_ALLOWED' | 'TERMS_NOT_ACCEPTED' | 'TERMS_ACCEPTANCE_REQUIRED';
export interface RegisterRequestContract { firstName: string; lastName: string; email: string; password: string; workspaceName: string; isClinician?: boolean; inviteToken: string; acceptedTerms: AcceptedTermContract[]; }
export interface RegisterMemberRequestContract { firstName: string; lastName: string; email: string; password: string; inviteToken: string; acceptedTerms: AcceptedTermContract[]; }
/** GET /environment (público). demo=true → aviso fijo "Entorno de prueba: usa solo datos inventados". */
export interface PublicEnvironmentContract { demo: boolean; }
export type InvitableRole = 'ADMIN' | 'THERAPIST' | 'ASSISTANT';
export interface MemberInviteContract { id: string; email: string; role: InvitableRole; isClinician: boolean; invitedById: string | null; expiresAt: string; createdAt: string; acceptedAt: string | null; revokedAt: string | null; }
/** POST /workspace-members/invites: el enlace solo viene en esta respuesta. */
export interface CreatedMemberInviteContract extends MemberInviteContract { inviteUrl: string; }

export type StaffRole = 'OWNER' | 'ADMIN' | 'THERAPIST' | 'ASSISTANT';
/** GET /auth/me: datos no clínicos del propio usuario (todos los roles de personal). */
export interface AuthMeContract { userId: string; email: string; firstName: string; lastName: string; role: StaffRole; isClinician: boolean; mfaEnabled: boolean; workspace: { id: string; name: string }; }
/** 403 de JwtAuthGuard: { statusCode: 403, code: 'MFA_SETUP_REQUIRED', message } (rol que exige MFA sin activarlo). */
export type AuthErrorCode = 'MFA_SETUP_REQUIRED' | 'CHANGE_PASSWORD_INVALID' | 'MFA_CODE_REQUIRED' | 'PASSWORD_UNCHANGED';
/**
 * POST /auth/change-password (JWT + CSRF, 5/min). `newPassword`: mínimo 12 caracteres y máximo 72 bytes UTF-8
 * (límite de bcrypt; copia en apps/api/src/auth/password-policy.ts y apps/web/lib/password-change.ts).
 * `mfaCode` (6 dígitos TOTP) es obligatorio si la cuenta tiene el MFA activo.
 */
export interface ChangePasswordRequestContract { currentPassword: string; newPassword: string; mfaCode?: string; }
/** Respuesta: la sesión actual se renueva (cookies nuevas) y todas las demás quedan cerradas. */
export interface ChangePasswordResponseContract { success: true; otherSessionsClosed: true; }

/** Conceptos admitidos en una línea de factura (lista cerrada; copia de apps/api/src/billing/invoice-concepts.ts). */
export const INVOICE_LINE_CONCEPTS = ['Sesión', 'Sesión de psicología', 'Sesión individual', 'Sesión de pareja', 'Sesión familiar', 'Sesión de grupo', 'Sesión online', 'Primera consulta', 'Sesión de evaluación', 'Informe psicológico', 'Bono de sesiones', 'Otro concepto'] as const;
export type InvoiceLineConcept = (typeof INVOICE_LINE_CONCEPTS)[number];
/**
 * Detalle de factura y respuestas de pago para roles que no son OWNER/ADMIN (ASSISTANT): los textos
 * libres llegan a null con un indicador si tenían contenido.
 * Factura: notes/notesHidden, voidReason/voidReasonHidden; línea antigua: description 'Otro concepto' + legacyDescriptionHidden.
 * Pago: notes/notesHidden, reference/referenceHidden, reversalReason/reversalReasonHidden.
 */
export interface BillingFreeTextFlagsContract { notesHidden?: true; voidReasonHidden?: true; referenceHidden?: true; reversalReasonHidden?: true; legacyDescriptionHidden?: true; }
/** GET /billing/invoices: resumen sin líneas ni notas; `concept` es el de la primera línea. */
export interface InvoiceListItemContract { id: string; patientId: string; invoiceNumber: string; status: string; currency: string; issueDate: string | null; dueDate: string | null; subtotalCents: number; taxCents: number; totalCents: number; paidCents: number; createdAt: string; updatedAt: string; concept: InvoiceLineConcept | null; patient: { id: string; firstName: string; lastName: string }; payments: { id: string; amountCents: number; method: string; paidAt: string }[]; }
