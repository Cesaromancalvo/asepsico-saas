import NoticeText from '@/components/NoticeText';
import { DRAFT_NOTICE, NOTICE_VERSION_LABEL, PORTAL_TERMS } from '@/lib/portal-signup-texts';

/** Normas de uso del portal (texto completo, pública y sin datos). */
export default function PortalTermsPage() {
  return (
    <main className="portal-login ps-public ps-legal">
      <section aria-labelledby="terms-title">
        <span className="eyebrow">Portal de pacientes</span>
        <p className="ps-draft" role="note">{DRAFT_NOTICE}</p>
        <h1 id="terms-title" className="ps-public-title"><NoticeText text={PORTAL_TERMS.title} /></h1>
        <ol className="ps-legal-terms">
          {PORTAL_TERMS.items.map((item) => (
            <li key={item.term}><strong>{item.term}</strong> <NoticeText text={item.text} /></li>
          ))}
        </ol>
        <small>Versión {NOTICE_VERSION_LABEL}</small>
      </section>
    </main>
  );
}
