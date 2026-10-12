'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { fetchLegalTerms, LegalDocument } from '@/lib/legal';

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

  // Al cargar los textos, lleva al documento del ancla (#doc-…), que antes no existía en la página.
  useEffect(() => {
    if (state !== 'ready' || !window.location.hash.startsWith('#doc-')) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [state]);

  return (
    <main className="shell">
      <div className="legal-page">
        <div className="card">
          <div className="brand">AsePsico</div>
          <h1>Condiciones vigentes</h1>
          <p className="muted">Estos son los textos que acepta la persona titular de cada consulta al darse de alta.</p>
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
                  <p>Este documento aún no es definitivo y no tiene validez legal.</p>
                </div>
              </div>
            )}
            <pre className="legal-text" tabIndex={0} aria-label={`Texto de ${doc.title}`}>{doc.text}</pre>
          </section>
        ))}
      </div>
    </main>
  );
}
