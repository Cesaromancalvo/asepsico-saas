'use client';

import type { LegalDocumentType } from '@asepsico/contracts';
import { legalDocumentHref, LEGAL_DOCUMENT_LABEL } from '@/lib/legal';

type Doc = { documentType: LegalDocumentType; version: string; title: string; draft: boolean };

type Props = {
  docs: Doc[];
  checked: Record<string, boolean>;
  onChange: (documentType: LegalDocumentType, value: boolean) => void;
  disabled?: boolean;
  /** Prefijo de los id para que dos listas en la misma página no choquen. */
  idPrefix?: string;
  /** Tras un intento de envío: marca como no válidas las casillas sin marcar. */
  showErrors?: boolean;
};

export function legalDocumentTitle(doc: Pick<Doc, 'documentType' | 'title'>) {
  return doc.title || LEGAL_DOCUMENT_LABEL[doc.documentType] || doc.documentType;
}

/** Mensaje de error que nombra los documentos sin aceptar ("Falta aceptar: …"). */
export function missingTermsMessage(docs: Doc[], checked: Record<string, boolean>): string | null {
  const missing = docs.filter((doc) => checked[doc.documentType] !== true).map(legalDocumentTitle);
  if (missing.length === 0) return null;
  const list = new Intl.ListFormat('es', { type: 'conjunction' }).format(missing);
  return `Para continuar, marca ${missing.length === 1 ? 'la casilla' : 'las casillas'} de: ${list}.`;
}

/**
 * Una casilla obligatoria por documento con enlace a su texto completo (/legal, en otra pestaña para
 * no perder el formulario). Cada profesional acepta por sí mismo. Si algún documento aún tiene datos
 * por completar (borrador), se avisa de forma visible.
 */
export default function TermsChecklist({ docs, checked, onChange, disabled, idPrefix = 'terms', showErrors }: Props) {
  const hasDraft = docs.some((doc) => doc.draft);
  return (
    <fieldset className="terms-fieldset" aria-describedby={`${idPrefix}-intro`}>
      <legend>Condiciones y privacidad</legend>
      <p id={`${idPrefix}-intro`} className="muted terms-intro">
        Lee los textos antes de continuar (se abren en otra pestaña) y marca cada casilla. Todas son obligatorias.
      </p>
      {hasDraft && (
        <div className="e1-notice" role="note">
          <div>
            <strong>Textos pendientes de completar</strong>
            <p>
              Alguno de estos documentos aún tiene datos por completar: todavía no es la versión definitiva y es posible
              que no puedas aceptarlo. Si te ocurre, vuelve a intentarlo más tarde.
            </p>
          </div>
        </div>
      )}
      {docs.map((doc) => {
        const id = `${idPrefix}-${doc.documentType}`;
        const title = legalDocumentTitle(doc);
        const invalid = showErrors === true && checked[doc.documentType] !== true;
        return (
          <div key={doc.documentType} className={`e1-checkbox${invalid ? ' is-invalid' : ''}`}>
            <input
              id={id}
              type="checkbox"
              aria-required="true"
              checked={checked[doc.documentType] === true}
              disabled={disabled}
              onChange={(event) => onChange(doc.documentType, event.target.checked)}
              aria-invalid={invalid || undefined}
              aria-describedby={`${id}-meta${invalid ? ` ${id}-error` : ''}`}
            />
            <span>
              <label htmlFor={id}>He leído y acepto: {title}</label>
              <small id={`${id}-meta`}>
                Versión {doc.version}
                {doc.draft && <span className="e1-badge readonly terms-draft-badge">Pendiente de completar</span>}
                {' '}
                {/* Separador y enlace juntos: con el chip del sistema visual el "·" se quedaba solo al final de línea en móvil. */}
                <span className="terms-doc-link">
                  ·{' '}
                  <a href={legalDocumentHref(doc.documentType)} target="_blank" rel="noopener noreferrer">
                    Leer el texto completo<span className="sr-only"> de {title} (se abre en otra pestaña)</span>
                  </a>
                </span>
              </small>
              {invalid && (
                <small id={`${id}-error`} className="terms-field-error">Falta marcar esta casilla.</small>
              )}
            </span>
          </div>
        );
      })}
    </fieldset>
  );
}
