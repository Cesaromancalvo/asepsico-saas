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
