import { createHash } from 'crypto';
import type { LegalDocumentType } from '@prisma/client';
import { PILOT_TERMS_TEXT } from './texts/pilot-terms';
import { DPA_ART28_TEXT } from './texts/dpa-art28';
import { PRIVACY_PRODUCT_TEXT } from './texts/privacy-product';

/**
 * Versiones VIGENTES de los documentos que acepta el titular (OWNER) de cada consulta.
 *
 * Por qué en el código y no en la BD:
 *  - Publicar una versión nueva es un cambio revisado (PR + Argos) y desplegado, con historial en
 *    git del texto exacto. Nadie puede cambiar las condiciones vigentes con una escritura en la BD.
 *  - El hash que queda en cada TermsAcceptance es el SHA-256 del texto que se sirvió en ese
 *    despliegue: la evidencia apunta a un texto reconstruible desde git.
 *  - No hace falta una pantalla de administración ni un rol de "superadmin" en la API.
 *
 * Para publicar una versión nueva: cambia el texto en texts/, sube `version` aquí y despliega.
 * Desde ese momento JwtAuthGuard devuelve 428 TERMS_ACCEPTANCE_REQUIRED al OWNER de cada workspace
 * hasta que acepte (POST /legal/terms/accept). Aunque olvidaras subir la versión, el hash cambia y
 * también obliga a aceptar de nuevo.
 */
export const PENDING_LEGAL_MARKER = '[PENDIENTE DEL DESPACHO]';

export type LegalDocument = {
  type: LegalDocumentType;
  version: string;
  title: string;
  text: string;
  textHash: string;
  /** true mientras el texto contenga marcadores pendientes del despacho. */
  draft: boolean;
};

const DEFINITIONS: Array<Pick<LegalDocument, 'type' | 'version' | 'title' | 'text'>> = [
  { type: 'PILOT_TERMS', version: '0.1-borrador', title: 'Condiciones del programa piloto', text: PILOT_TERMS_TEXT },
  { type: 'DPA_ART28', version: '0.1-borrador', title: 'Contrato de encargo del tratamiento (art. 28 RGPD)', text: DPA_ART28_TEXT },
  { type: 'PRIVACY_PRODUCT', version: '0.1-borrador', title: 'Política de privacidad para profesionales', text: PRIVACY_PRODUCT_TEXT },
];

export function hashLegalText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const CURRENT: readonly LegalDocument[] = Object.freeze(
  DEFINITIONS.map((d) => Object.freeze({ ...d, textHash: hashLegalText(d.text), draft: d.text.includes(PENDING_LEGAL_MARKER) })),
);

/** Documentos vigentes. Función (no constante) para que los tests puedan simular una versión nueva. */
export function getCurrentLegalDocuments(): readonly LegalDocument[] {
  return CURRENT;
}
