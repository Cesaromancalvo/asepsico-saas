'use client';
import Sidebar from '@/components/Sidebar';
import {
  CHANGES_URL,
  STATUS_URL,
  SUPPORT_COMMITMENT,
  SUPPORT_DISCLAIMER,
  SUPPORT_EMAIL,
  SUPPORT_NO_PATIENT_DATA,
  SUPPORT_NO_PATIENT_DATA_DETAIL,
  SUPPORT_SUBJECT,
  SUPPORT_SUBJECT_BLOCKED,
  supportMailto,
} from '@/lib/support';

export default function SupportPage() {
  return (
    <div className="app-layout">
      <Sidebar syncText="Ayuda y soporte" />
      <main className="patient-record-page">
        <header className="patient-record-header">
          <div>
            <span className="eyebrow">Ayuda</span>
            <h1>Ayuda y soporte</h1>
            <p>Si algo no funciona o tienes una duda, escríbenos. Te contestamos por correo.</p>
          </div>
        </header>

        <section className="patient-card" aria-labelledby="support-warning-title" role="note">
          <h2 id="support-warning-title">{SUPPORT_NO_PATIENT_DATA}</h2>
          <p>{SUPPORT_NO_PATIENT_DATA_DETAIL}</p>
        </section>

        <section className="patient-card" aria-labelledby="support-contact-title">
          <h2 id="support-contact-title">Soporte</h2>
          <p>
            Escribe a <a href={supportMailto(SUPPORT_SUBJECT)}>{SUPPORT_EMAIL}</a> contando qué intentabas hacer y qué ha pasado.
          </p>
          <ul>
            {SUPPORT_COMMITMENT.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className="muted">{SUPPORT_DISCLAIMER}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <a className="button primary" href={supportMailto(SUPPORT_SUBJECT)}>Escribir a soporte</a>
            <a className="button secondary" href={supportMailto(SUPPORT_SUBJECT_BLOCKED)}>No puedo trabajar</a>
          </div>
        </section>

        <section className="patient-card" aria-labelledby="support-status-title">
          <h2 id="support-status-title">Estado y cambios</h2>
          <p>Antes de escribirnos, mira si hay una incidencia conocida. Aquí también avisamos de los cambios que afectan a tu día a día.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <a className="button secondary" href={STATUS_URL} target="_blank" rel="noopener noreferrer">
              Estado del servicio<span className="visually-hidden"> (se abre en una pestaña nueva)</span>
            </a>
            <a className="button secondary" href={CHANGES_URL} target="_blank" rel="noopener noreferrer">
              Cambios y novedades<span className="visually-hidden"> (se abre en una pestaña nueva)</span>
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
