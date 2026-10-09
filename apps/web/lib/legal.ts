'use client';

import { useEffect, useState } from 'react';
import type { AcceptedTermContract, LegalDocumentContract, LegalDocumentType, TermsStatusContract } from '@asepsico/contracts';
import { api, ApiError } from './api';

/*
 * Condiciones versionadas e invitaciones (registro cerrado).
 *
 * - Los textos vigentes los sirve GET /legal/terms (público) con versión y hash. Al aceptar se
 *   devuelven tal cual {documentType, version, textHash}: así la API sabe qué texto se mostró.
 * - El token de invitación llega en el FRAGMENTO (#invite=…), que el navegador no envía al
 *   servidor ni en el Referer. Se lee una vez, vive solo en memoria (nunca en localStorage) y se
 *   quita de la URL al terminar con history.replaceState.
 */

export type LegalDocument = LegalDocumentContract;
export type TermsStatus = TermsStatusContract;

/**
 * Nombre de respaldo de cada documento (si la API no envía título). Coincide con los títulos que
 * sirve la API en el piloto demo. DPA_ART28 no está vigente durante el piloto demo (en el demo
 * AsePsico no trata datos de pacientes); se mantiene para cuando vuelva con el piloto real.
 */
export const LEGAL_DOCUMENT_LABEL: Record<LegalDocumentType, string> = {
  PILOT_TERMS: 'Condiciones de uso del piloto demo',
  PRIVACY_PRODUCT: 'Política de privacidad para profesionales (piloto demo)',
  DPA_ART28: 'Contrato de encargo del tratamiento (art. 28 RGPD)',
};

/** Ancla de cada documento en la página pública /legal. */
export function legalDocumentHref(documentType: LegalDocumentType) {
  return `/legal#doc-${documentType}`;
}

/** id del apartado "## N." de un documento en /legal (p. ej. doc-PILOT_TERMS-apartado-4). */
export function legalSectionId(documentType: LegalDocumentType, section: string) {
  return `doc-${documentType}-apartado-${section}`;
}

/** 503 LEGAL_TERMS_DRAFT: algún texto vigente aún tiene datos por completar y no se puede aceptar. */
export function isLegalTermsDraftError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503 && err.code === 'LEGAL_TERMS_DRAFT';
}

export const LEGAL_TERMS_DRAFT_MESSAGE =
  'Las condiciones del piloto aún tienen datos por completar y todavía no se pueden aceptar. No es un error tuyo: ' +
  'vuelve a intentarlo más tarde.';

/** Lo que se envía al aceptar: exactamente lo recibido (sin título ni texto). */
export function toAcceptedTerm(doc: Pick<LegalDocument, 'documentType' | 'version' | 'textHash'>): AcceptedTermContract {
  return { documentType: doc.documentType, version: doc.version, textHash: doc.textHash };
}

export function fetchLegalTerms() {
  return api<LegalDocument[]>('/legal/terms');
}

/** Lee el token de `#invite=…`. Nunca de la query (?invite=), que sí viaja al servidor. */
export function readInviteTokenFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('invite')?.trim();
  return token && token.length <= 200 ? token : null;
}

/** Quita el fragmento (con el token) de la URL y del historial sin recargar la página. */
export function clearUrlFragment() {
  if (typeof window === 'undefined' || !window.location.hash) return;
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
}

/**
 * Token de invitación de la URL, leído tras montar (el fragmento no existe en el servidor). En el
 * MISMO efecto se quita #invite= de la barra y del historial: el token queda solo en el estado de
 * React (los reintentos funcionan) y no se queda en la URL aunque el alta falle o se abandone.
 */
export function useInviteToken(): { ready: boolean; token: string | null } {
  const [state, setState] = useState<{ ready: boolean; token: string | null }>({ ready: false, token: null });
  useEffect(() => {
    const token = readInviteTokenFromHash();
    clearUrlFragment();
    setState({ ready: true, token });
  }, []);
  return state;
}

let statusCache: Promise<TermsStatus | null> | null = null;

/**
 * Estado de las condiciones de la persona que ha iniciado sesión (cada profesional acepta por sí
 * mismo), cacheado durante la navegación.
 * Devuelve null si no se puede saber (sin sesión, MFA pendiente…): en ese caso no se avisa de nada.
 */
export function fetchTermsStatus(force = false): Promise<TermsStatus | null> {
  if (statusCache && !force) return statusCache;
  const pending = api<TermsStatus>('/legal/terms/status').catch(() => {
    statusCache = null;
    return null;
  });
  statusCache = pending;
  return pending;
}

export function invalidateTermsStatus() {
  statusCache = null;
}

export function useTermsStatus(): TermsStatus | null {
  const [status, setStatus] = useState<TermsStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchTermsStatus().then((value) => {
      if (!cancelled) setStatus(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return status;
}

const GENERIC_REGISTRATION_ERROR = 'No se ha podido completar el registro. Revisa el enlace de invitación o pide uno nuevo a quien te invitó.';

/**
 * Mensaje de error de un alta (/register o /join). Un 400 nunca revela el motivo (invitación usada,
 * caducada, de otro correo, cuenta existente…): la API ya responde neutro y la web también.
 */
export function registrationErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'No se ha podido conectar. Comprueba tu conexión e inténtalo de nuevo.';
  if (isLegalTermsDraftError(err)) return LEGAL_TERMS_DRAFT_MESSAGE;
  if (err.status === 429) return err.message;
  if (err.status === 400) return GENERIC_REGISTRATION_ERROR;
  return 'No se ha podido completar el registro. Inténtalo de nuevo en unos minutos.';
}
