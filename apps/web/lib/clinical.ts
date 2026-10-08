'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

/*
 * Acceso clínico en la web (E1).
 *
 * La web YA NO decide por rol quién ve contenido clínico. Lo decide la API (ClinicalAccessService):
 * solo quien trata al paciente con un proceso ACTIVO ve su contenido; el autor de un proceso no
 * activo conserva la lectura de lo suyo; OWNER/ADMIN por su rol solo ven datos administrativos.
 * Aquí solo se interpreta lo que devuelve la API (`canReadClinical`, `readOnly`, `title: null`,
 * 403) para no insinuar datos que no corresponden y para que un 403 no rompa la pantalla.
 *
 * El rol del usuario se sigue usando, pero solo para acciones ADMINISTRATIVAS (gestionar el
 * equipo, cambiar el estado de un proceso, abrir un proceso a nombre de otro profesional).
 */

export type StaffRole = 'OWNER' | 'ADMIN' | 'THERAPIST' | 'ASSISTANT';

/** Quién usa la web. Es solo una pista para la UI: el control real lo hace el backend. */
export type Viewer = {
  userId: string | null;
  role: StaffRole | null;
  /** Atiende pacientes (THERAPIST siempre, ASSISTANT nunca, OWNER/ADMIN según su ficha). */
  isClinician: boolean;
  firstName: string | null;
  lastName: string | null;
  /** Nombre de la consulta (dato administrativo). Un ASSISTANT no lo recibe del dashboard. */
  workspaceName: string | null;
};

const ANONYMOUS_VIEWER: Viewer = { userId: null, role: null, isClinician: false, firstName: null, lastName: null, workspaceName: null };

type DashboardProfessional = {
  professional?: { userId?: string; role?: string; isClinician?: boolean; firstName?: string; lastName?: string; workspaceName?: string | null };
};

let viewerCache: Promise<Viewer> | null = null;

/**
 * Datos del propio usuario desde GET /dashboard (rol, si atiende pacientes y su id). El dashboard
 * responde 403 a un ASSISTANT: se interpreta como "sin acceso clínico ni de gestión". Se cachea
 * durante la navegación (una sola petición para la barra lateral y la pantalla); un error que no
 * sea 403 no se cachea para poder reintentar.
 */
export function fetchViewer(): Promise<Viewer> {
  if (viewerCache) return viewerCache;
  const pending = api<DashboardProfessional>('/dashboard')
    .then(({ professional }) => {
      const role = (['OWNER', 'ADMIN', 'THERAPIST', 'ASSISTANT'] as const).find((r) => r === professional?.role) ?? null;
      return {
        userId: professional?.userId ?? null,
        role,
        isClinician: role === 'THERAPIST' || ((role === 'OWNER' || role === 'ADMIN') && professional?.isClinician === true),
        firstName: professional?.firstName ?? null,
        lastName: professional?.lastName ?? null,
        workspaceName: professional?.workspaceName ?? null,
      };
    })
    .catch((err: unknown) => {
      if (isForbidden(err)) return { ...ANONYMOUS_VIEWER, role: 'ASSISTANT' as const };
      viewerCache = null;
      return ANONYMOUS_VIEWER;
    });
  viewerCache = pending;
  return pending;
}

/** Fuerza a releer el usuario (p. ej. tras cambiar su atributo "Atiende pacientes"). */
export function invalidateViewer() {
  viewerCache = null;
}

/** `null` mientras se carga. */
export function useViewer(): Viewer | null {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchViewer().then((value) => {
      if (!cancelled) setViewer(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return viewer;
}

export function isAdminRole(role?: string | null): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Roles que entran en los módulos de procesos y mensajes (aunque no vean contenido clínico). */
export function isStaffWithProcessAccess(role?: string | null): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'THERAPIST';
}

export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

export const ROLE_LABEL: Record<StaffRole, string> = {
  OWNER: 'Titular',
  ADMIN: 'Administración',
  THERAPIST: 'Terapeuta',
  ASSISTANT: 'Asistente',
};

/* ------------------------------------------------------------------------------------------ */
/* Procesos clínicos                                                                           */
/* ------------------------------------------------------------------------------------------ */

export type ProcessStatus = 'ACTIVE' | 'PAUSED' | 'DISCHARGED' | 'CLOSED';

/** Fila de GET /clinical-processes. `title` llega a null si no hay acceso a su contenido. */
export type ClinicalProcessRow = {
  id: string;
  patientId: string;
  therapistId: string;
  title: string | null;
  status: ProcessStatus;
  modality?: string | null;
  frequency?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  updatedAt?: string | null;
  therapist?: { id: string; firstName: string; lastName: string } | null;
  _count?: { sessions: number };
  canReadClinical?: boolean;
};

export type PatientClinicalAccess = {
  state: 'loading' | 'ready' | 'denied' | 'error';
  processes: ClinicalProcessRow[];
  /** Trata al paciente: tiene acceso a un proceso ACTIVO (lectura y escritura clínica). */
  treating: boolean;
  /** Puede leer algo clínico de este paciente (trata, o es autor de un proceso no activo). */
  readable: boolean;
  /** Puede leer, pero no escribir: su proceso está en pausa, de alta o cerrado. */
  readOnly: boolean;
};

const LOADING_ACCESS: PatientClinicalAccess = { state: 'loading', processes: [], treating: false, readable: false, readOnly: false };
const NO_ACCESS: PatientClinicalAccess = { state: 'denied', processes: [], treating: false, readable: false, readOnly: false };

/**
 * Interpreta `canReadClinical` del listado de procesos de un paciente:
 *  - quien trata al paciente lee todos sus procesos y al menos uno está ACTIVO;
 *  - el autor de procesos no activos solo lee los suyos, ninguno ACTIVO → solo lectura;
 *  - nadie más lee ninguno.
 */
export function summarizeAccess(processes: ClinicalProcessRow[]): PatientClinicalAccess {
  const readableRows = processes.filter((p) => p.canReadClinical === true);
  const treating = readableRows.some((p) => p.status === 'ACTIVE');
  const readable = readableRows.length > 0;
  return { state: 'ready', processes, treating, readable, readOnly: readable && !treating };
}

/**
 * Procesos de un paciente con lo que la API deja leer de cada uno. Un 403 (rol sin acceso al
 * módulo) se tolera devolviendo "sin acceso": la pantalla sigue con los datos administrativos.
 */
export async function fetchPatientClinicalAccess(patientId: string): Promise<PatientClinicalAccess> {
  try {
    const result = await api<{ data: ClinicalProcessRow[] }>(
      `/clinical-processes?patientId=${encodeURIComponent(patientId)}&pageSize=100`,
    );
    return summarizeAccess(result.data);
  } catch (err) {
    return isForbidden(err) ? NO_ACCESS : { ...NO_ACCESS, state: 'error' };
  }
}

/**
 * Acceso clínico del usuario a un paciente. Con `enabled=false` (p. ej. un ASSISTANT, que no
 * entra en el módulo de procesos) no se pregunta a la API: así no se generan denegaciones
 * auditadas inútiles.
 */
export function usePatientClinicalAccess(patientId: string | null | undefined, enabled: boolean) {
  // Se guarda para qué paciente es la respuesta: al cambiar de paciente se devuelve "cargando"
  // (nunca los permisos de otro); en una recarga del mismo se mantiene lo anterior hasta tener
  // la respuesta nueva.
  const [loaded, setLoaded] = useState<{ patientId: string; access: PatientClinicalAccess } | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (!patientId || !enabled) return;
    let cancelled = false;
    fetchPatientClinicalAccess(patientId).then((value) => {
      if (!cancelled) setLoaded({ patientId, access: value });
    });
    return () => {
      cancelled = true;
    };
  }, [patientId, enabled, version]);
  let access: PatientClinicalAccess = LOADING_ACCESS;
  if (patientId && !enabled) access = NO_ACCESS;
  else if (patientId && loaded?.patientId === patientId) access = loaded.access;
  return { access, reload };
}

/**
 * Reactivar, pausar, cerrar o "cerrar y abrir uno nuevo": OWNER/ADMIN de cualquier proceso; el
 * profesional, solo del suyo y si sigue atendiendo pacientes (mismo criterio que la API).
 */
export function canManageProcess(viewer: Viewer | null, process: { therapistId?: string | null; therapist?: { id: string } | null }): boolean {
  if (!viewer) return false;
  if (isAdminRole(viewer.role)) return true;
  const therapistId = process.therapistId ?? process.therapist?.id ?? null;
  return Boolean(viewer.userId && therapistId === viewer.userId && viewer.isClinician);
}

/**
 * Motivo de consulta del paciente desde GET /patients/:id/consultation-reason. Solo se pide si
 * la API ya indicó que el usuario lee contenido clínico de este paciente; un 403 o cualquier
 * otro fallo se tolera devolviendo null.
 */
export async function fetchConsultationReason(patientId: string): Promise<string | null> {
  try {
    const data = await api<{ patientId: string; consultationReason: string | null }>(
      `/patients/${patientId}/consultation-reason`,
    );
    return data.consultationReason || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Sesiones                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * Lectura del detalle GET /sessions/:id:
 *  - la vista administrativa (OWNER/ADMIN que no tratan, ASSISTANT) no trae `notes`;
 *  - quien trata sin ser el autor recibe `notes` pero no `internalSummary`;
 *  - solo el autor, con el proceso ACTIVO, puede escribir (la API lo vuelve a comprobar).
 */
export function sessionClinicalAccess(
  session: { therapistId?: string | null; clinicalProcess?: { status?: string | null } | null },
  viewer: Viewer | null,
) {
  const canRead = Object.prototype.hasOwnProperty.call(session, 'notes');
  const isAuthor = viewer?.userId
    ? session.therapistId === viewer.userId
    : Object.prototype.hasOwnProperty.call(session, 'internalSummary');
  const processStatus = session.clinicalProcess?.status ?? null;
  const processInactive = Boolean(processStatus && processStatus !== 'ACTIVE');
  return {
    canRead,
    isAuthor: canRead && isAuthor,
    readOnly: !canRead || !isAuthor || processInactive,
    processInactive,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Etiquetas                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const MODALITY_LABEL: Record<string, string> = {
  IN_PERSON: 'Presencial',
  ONLINE: 'Online',
  HYBRID: 'Híbrida',
};

const PROCESS_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Proceso activo',
  PAUSED: 'Proceso pausado',
  DISCHARGED: 'Proceso de alta',
  CLOSED: 'Proceso cerrado',
};

export function modalityLabel(modality?: string | null): string | null {
  return modality ? MODALITY_LABEL[modality] ?? null : null;
}

/**
 * Etiqueta neutra de un proceso clínico para vistas generales: estado + modalidad
 * (p. ej. "Proceso activo · Presencial"). Sustituye al título, que no llega a quien no tiene
 * acceso a su contenido porque puede revelar contenido clínico.
 */
export function processLabel(process?: { status?: string | null; modality?: string | null } | null): string {
  if (!process) return 'Sin proceso activo';
  const status = (process.status && PROCESS_STATUS_LABEL[process.status]) || 'Proceso clínico';
  const modality = modalityLabel(process.modality);
  return modality ? `${status} · ${modality}` : status;
}

/** Título del proceso si la API lo envía; si llega nulo, la etiqueta neutra. */
export function processTitle(process: { title?: string | null; status?: string | null; modality?: string | null }): string {
  return process.title?.trim() ? process.title : processLabel(process);
}

export function therapistName(person?: { firstName?: string | null; lastName?: string | null } | null): string {
  const name = [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim();
  return name || 'Sin profesional asignado';
}
