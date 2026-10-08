export type PatientStatus = 'ACTIVE' | 'PAUSED' | 'DISCHARGED' | 'ARCHIVED';
export interface PatientContract { id:string; workspaceId:string; firstName:string; lastName:string; email?:string|null; phone?:string|null; status:PatientStatus; createdAt:string; updatedAt:string; }

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
