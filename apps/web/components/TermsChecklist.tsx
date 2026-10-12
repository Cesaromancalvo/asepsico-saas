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
};

/**
 * Una casilla por documento con enlace a su texto completo (/legal, en otra pestaña para no perder
 * el formulario). Si algún documento es un borrador, se avisa de forma visible.
 */
export default function TermsChecklist({ docs, checked, onChange, disabled, idPrefix = 'terms' }: Props) {
  const hasDraft = docs.some((doc) => doc.draft);
  return (
    <fieldset className="terms-fieldset">
      <legend>Condiciones</legend>
      {hasDraft && (
        <div className="e1-notice" role="note">
          <div>
            <strong>Textos en borrador</strong>
            <p>Alguno de estos documentos aún es un borrador sin validez legal. El texto definitivo lo facilitará el despacho antes del uso con pacientes reales.</p>
          </div>
        </div>
      )}
      {docs.map((doc) => {
        const id = `${idPrefix}-${doc.documentType}`;
        const title = doc.title || LEGAL_DOCUMENT_LABEL[doc.documentType] || doc.documentType;
        return (
          <div key={doc.documentType} className="e1-checkbox">
            <input
              id={id}
              type="checkbox"
              required
              checked={checked[doc.documentType] === true}
              disabled={disabled}
              onChange={(event) => onChange(doc.documentType, event.target.checked)}
              aria-describedby={`${id}-meta`}
            />
            <span>
              <label htmlFor={id}>He leído y acepto: {title}</label>
              <small id={`${id}-meta`}>
                Versión {doc.version}
                {doc.draft && <span className="e1-badge readonly terms-draft-badge">Borrador</span>}
                {' · '}
                <a href={legalDocumentHref(doc.documentType)} target="_blank" rel="noopener noreferrer">
                  Leer el texto completo<span className="sr-only"> de {title} (se abre en otra pestaña)</span>
                </a>
              </small>
            </span>
          </div>
        );
      })}
    </fieldset>
  );
}
