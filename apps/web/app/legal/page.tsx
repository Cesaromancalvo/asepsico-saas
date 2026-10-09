'use client';

import Link from 'next/link';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { fetchLegalTerms, legalSectionId, LegalDocument } from '@/lib/legal';

/**
 * El texto se muestra tal cual (el hash aceptado es el de este texto). Solo se envuelven los
 * títulos "## N." en un <span> con id para poder enlazar a un apartado (p. ej. el aviso de entorno
 * de prueba enlaza al apartado 4 de las condiciones).
 */
function renderLegalText(doc: LegalDocument): ReactNode[] {
  return doc.text.split(/(^## \d+\..*$)/m).map((part, index) => {
    const match = /^## (\d+)\./.exec(part);
    if (!match) return part;
    return <span key={index} id={legalSectionId(doc.documentType, match[1])} className="legal-text-heading">{part}</span>;
  });
}

/** Textos vigentes de las condiciones (público). Cada documento tiene un ancla #doc-TIPO. */
export default function LegalPage() {
  const [docs, setDocs] = useState<LegalDocument[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      setDocs(await fetchLegalTerms());
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Al cargar los textos, lleva al documento o apartado del ancla (#doc-…), que antes no existía
  // en la página. También si el ancla cambia estando ya aquí (enlace del aviso de entorno de prueba).
  useEffect(() => {
    if (state !== 'ready') return;
    const scrollToHash = () => {
      if (!window.location.hash.startsWith('#doc-')) return;
      document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView();
    };
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    return () => window.removeEventListener('hashchange', scrollToHash);
  }, [state]);

  return (
    <main className="shell">
      <div className="legal-page">
        <div className="card">
          <div className="brand">AsePsico</div>
          <h1>Condiciones vigentes</h1>
          <p className="muted">
            Estos son los textos que acepta cada profesional al darse de alta, tanto quien crea la consulta como las
            personas que se unen por invitación.
          </p>
          <Link href="/login">Ir a iniciar sesión</Link>
        </div>
        {state === 'loading' && <div className="card"><p className="muted" role="status">Cargando los textos…</p></div>}
        {state === 'error' && (
          <div className="card" role="alert">
            <p>No se han podido cargar los textos.</p>
            <button type="button" className="button secondary" onClick={load}>Reintentar</button>
          </div>
        )}
        {state === 'ready' && docs.length === 0 && <div className="card"><p className="muted">No hay documentos publicados.</p></div>}
        {state === 'ready' && docs.map((doc) => (
          <section key={doc.documentType} id={`doc-${doc.documentType}`} className="card e1-stack" aria-labelledby={`title-${doc.documentType}`}>
            <div>
              <h2 id={`title-${doc.documentType}`} style={{ marginBottom: 4 }}>{doc.title}</h2>
              <small className="muted">
                Versión {doc.version}
                {doc.draft && <span className="e1-badge readonly terms-draft-badge">Borrador</span>}
              </small>
            </div>
            {doc.draft && (
              <div className="e1-notice" role="note">
                <div>
                  <strong>Texto en borrador</strong>
                  <p>A este documento aún le faltan datos por completar, así que todavía no es la versión definitiva.</p>
                </div>
              </div>
            )}
            <pre className="legal-text" tabIndex={0} aria-label={`Texto de ${doc.title}`}>{renderLegalText(doc)}</pre>
          </section>
        ))}
      </div>
    </main>
  );
}
