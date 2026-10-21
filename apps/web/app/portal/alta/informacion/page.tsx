import NoticeText from '@/components/NoticeText';
import { DRAFT_NOTICE, LAYER2, NOTICE_VERSION_LABEL } from '@/lib/portal-signup-texts';

/** Capa 2 de la información art. 13 del alta por QR (página propia, pública y sin datos). */
export default function SignupPrivacyInfoPage() {
  return (
    <main className="portal-login ps-public ps-legal">
      <section aria-labelledby="info-title">
        <span className="eyebrow">Portal de pacientes</span>
        <p className="ps-draft" role="note">{DRAFT_NOTICE}</p>
        <h1 id="info-title" className="ps-public-title">{LAYER2.title}</h1>
        <dl className="ps-legal-list">
          {LAYER2.rows.map((row) => (
            <div key={row.term}><dt>{row.term}</dt><dd><NoticeText text={row.text} /></dd></div>
          ))}
        </dl>
        <small>Versión {NOTICE_VERSION_LABEL}</small>
      </section>
    </main>
  );
}
