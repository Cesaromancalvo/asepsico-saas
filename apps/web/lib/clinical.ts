'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

/** Roles con acceso a contenido clínico (mismo criterio que la API). ASSISTANT queda fuera. */
export const CLINICAL_ROLES = ['OWNER', 'ADMIN', 'THERAPIST'] as const;

/**
 * Averigua si quien usa la web tiene un rol clínico. Reutiliza GET /dashboard, que es la única
 * pantalla que hoy expone el rol (`professional.role`) y que ya responde 403 a los roles no
 * clínicos. Ante cualquier error devuelve false: es solo una pista para la UI (ocultar campos,
 * no pedir datos clínicos); el control real lo hace el backend.
 */
export async function fetchIsClinicalRole(): Promise<boolean> {
  try {
    const data = await api<{ professional?: { role?: string } }>('/dashboard');
    return (CLINICAL_ROLES as readonly string[]).includes(data.professional?.role ?? '');
  } catch {
    return false;
  }
}

/** `null` mientras se comprueba; después true/false. */
export function useIsClinicalRole(): boolean | null {
  const [isClinical, setIsClinical] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchIsClinicalRole().then((value) => {
      if (!cancelled) setIsClinical(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return isClinical;
}

/**
 * Motivo de consulta del paciente desde GET /patients/:id/consultation-reason (solo acceso
 * clínico). Un 403 (ASSISTANT o THERAPIST sin proceso propio) o cualquier otro fallo se tolera
 * devolviendo null: la pantalla sigue funcionando sin el dato.
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
 * (p. ej. "Proceso activo · Presencial"). Sustituye al título, que ya no llega a estas vistas
 * porque puede revelar contenido clínico.
 */
export function processLabel(process?: { status?: string | null; modality?: string | null } | null): string {
  if (!process) return 'Sin proceso activo';
  const status = (process.status && PROCESS_STATUS_LABEL[process.status]) || 'Proceso clínico';
  const modality = modalityLabel(process.modality);
  return modality ? `${status} · ${modality}` : status;
}
