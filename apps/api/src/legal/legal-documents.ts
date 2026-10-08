import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import type { LegalDocumentType } from '@prisma/client';
import { PILOT_TERMS_TEXT } from './texts/pilot-terms';
import { PRIVACY_PRODUCT_TEXT } from './texts/privacy-product';

/**
 * Versiones VIGENTES de los documentos que acepta cada profesional (titular y miembros invitados).
 *
 * Por qué en el código y no en la BD:
 *  - Publicar una versión nueva es un cambio revisado (PR + Argos) y desplegado, con historial en
 *    git del texto exacto. Nadie puede cambiar las condiciones vigentes con una escritura en la BD.
 *  - El hash que queda en cada TermsAcceptance es el SHA-256 del texto que se sirvió en ese
 *    despliegue: la evidencia apunta a un texto reconstruible desde git más los datos del titular
 *    que inyecta el despliegue (ver LEGAL_ENV_PLACEHOLDERS).
 *  - No hace falta una pantalla de administración ni un rol de "superadmin" en la API.
 *
 * Para publicar una versión nueva: cambia el texto en texts/, sube `version` aquí y despliega.
 * Desde ese momento JwtAuthGuard devuelve 428 TERMS_ACCEPTANCE_REQUIRED a cada profesional hasta
 * que la acepte (POST /legal/terms/accept). Aunque olvidaras subir la versión, el hash cambia y
 * también obliga a aceptar de nuevo.
 *
 * Piloto demo: DPA_ART28 NO está vigente (sigue siendo borrador y en el demo AsePsico no es
 * encargado: no debe haber datos de pacientes). Vuelve a DEFINITIONS con el piloto real; su texto
 * se conserva en texts/dpa-art28.ts.
 */
export const PENDING_LEGAL_MARKER = '[PENDIENTE DEL DESPACHO]';

/**
 * Cualquier marcador sin rellenar en mayúsculas entre corchetes: [NIF], [DOMICILIO],
 * [EMAIL_CONTACTO], [PENDIENTE DEL DESPACHO]... Un texto que lo contenga es BORRADOR (en
 * producción, 503 LEGAL_TERMS_DRAFT): así nunca se acepta un texto con "[NIF]".
 */
export const UNFILLED_MARKER_RE = /\[[A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ_ ]*\]/;

/**
 * Datos del titular que NO pueden ir en git (el repositorio es público). Los pone el despliegue
 * (variables de entorno de Render, nunca en el repo ni en render.yaml). Sin ellos, o con un valor
 * mal formado, el marcador se queda tal cual y el documento cuenta como borrador.
 */
export const LEGAL_ENV_PLACEHOLDERS = [
  { marker: '[NIF]', env: 'LEGAL_TITULAR_NIF', normalize: normalizeNif },
  { marker: '[DOMICILIO]', env: 'LEGAL_TITULAR_DOMICILIO', normalize: normalizeAddress },
] as const;

export type LegalDocument = {
  type: LegalDocumentType;
  version: string;
  title: string;
  text: string;
  textHash: string;
  /** true mientras el texto contenga algún marcador sin rellenar. */
  draft: boolean;
};

const DEFINITIONS: Array<Pick<LegalDocument, 'type' | 'version' | 'title' | 'text'>> = [
  { type: 'PILOT_TERMS', version: 'demo-1.0', title: 'Condiciones de uso del piloto demo', text: PILOT_TERMS_TEXT },
  { type: 'PRIVACY_PRODUCT', version: 'demo-1.0', title: 'Política de privacidad para profesionales (piloto demo)', text: PRIVACY_PRODUCT_TEXT },
];

const NIF_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** DNI (8 cifras + letra) o NIE (X/Y/Z + 7 cifras + letra), con la letra de control correcta. */
export function normalizeNif(raw: string): string | null {
  const value = raw.replace(/[\s.-]/g, '').toUpperCase();
  const match = /^([0-9XYZ])([0-9]{7})([A-Z])$/.exec(value);
  if (!match) return null;
  const niePrefix = 'XYZ'.indexOf(match[1]); // NIE: X→0, Y→1, Z→2
  const digits = (niePrefix >= 0 ? String(niePrefix) : match[1]) + match[2];
  return NIF_LETTERS[Number(digits) % 23] === match[3] ? value : null;
}

/** Una línea de texto postal: letras, cifras y puntuación habitual; sin corchetes ni Markdown. */
export function normalizeAddress(raw: string): string | null {
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length < 10 || value.length > 200) return null;
  return /^[\p{L}\p{N} .,ºª°'’/()-]+$/u.test(value) ? value : null;
}

export function hashLegalText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function isDraftLegalText(text: string): boolean {
  return text.includes(PENDING_LEGAL_MARKER) || UNFILLED_MARKER_RE.test(text);
}

const logger = new Logger('LegalDocuments');

/** Sustituye los datos del titular desde el entorno. Nunca registra los valores. */
function fillFromEnv(text: string, env: NodeJS.ProcessEnv): string {
  let result = text;
  for (const { marker, env: name, normalize } of LEGAL_ENV_PLACEHOLDERS) {
    if (!result.includes(marker)) continue;
    const raw = env[name];
    if (!raw) continue;
    const value = normalize(raw);
    if (!value) {
      logger.warn(`${name} tiene un formato no válido: el documento seguirá como borrador`);
      continue;
    }
    result = result.split(marker).join(value);
  }
  return result;
}

/** Construye los documentos vigentes con los datos del entorno (exportado para los tests). */
export function buildLegalDocuments(env: NodeJS.ProcessEnv = process.env): readonly LegalDocument[] {
  return Object.freeze(
    DEFINITIONS.map((d) => {
      const text = fillFromEnv(d.text, env);
      return Object.freeze({ ...d, text, textHash: hashLegalText(text), draft: isDraftLegalText(text) });
    }),
  );
}

let current: readonly LegalDocument[] | null = null;

/**
 * Documentos vigentes. Se construyen en la primera llamada (no al importar el módulo) para leer
 * el entorno ya cargado. Función (no constante) para que los tests puedan simular una versión nueva.
 */
export function getCurrentLegalDocuments(): readonly LegalDocument[] {
  if (!current) current = buildLegalDocuments();
  return current;
}
