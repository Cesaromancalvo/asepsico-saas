'use client';
import type { StaffEmailKind, StaffEmailPreference } from '@asepsico/contracts';
import { defaultBadge, EMAIL_KIND_TEXT, EMAIL_PRIVACY_LINE, visibleKinds } from '../lib/email-preferences';

export type RowState = { saving?: boolean; error?: string };

type Props = {
  workspaceName: string | null;
  preferences: Partial<Record<StaffEmailKind, StaffEmailPreference>>;
  rows: Partial<Record<StaffEmailKind, RowState>>;
  /** Último resultado para lectores de pantalla («Guardado: …»). */
  status: string;
  onToggle: (kind: StaffEmailKind, enabled: boolean) => void;
};

/**
 * Interruptores de «Avisos por email». Solo pinta lo que la API marca como disponible para el rol;
 * nada de pacientes. Cada interruptor guarda al momento y muestra su propio error.
 */
export default function EmailPreferencesPanel({ workspaceName, preferences, rows, status, onToggle }: Props) {
  const kinds = visibleKinds(preferences);
  return (
    <section className="patient-card ep-card" aria-labelledby="ep-title">
      <h2 id="ep-title">Qué emails quieres recibir</h2>
      <p className="ep-privacy">{EMAIL_PRIVACY_LINE}</p>
      <p className="muted ep-scope">
        {workspaceName ? <>Estos ajustes son de <strong>{workspaceName}</strong>.</> : 'Estos ajustes son de tu espacio actual.'}{' '}
        Si trabajas en más de un espacio, cada uno tiene los suyos. Los cambios se guardan al momento.
      </p>
      {kinds.length === 0 ? (
        <p className="ep-empty">Con tu rol no hay avisos por email que configurar en este espacio.</p>
      ) : (
        <ul className="ep-list">
          {kinds.map((kind) => {
            const pref = preferences[kind]!;
            const row = rows[kind] ?? {};
            const id = `ep-${kind}`;
            const text = EMAIL_KIND_TEXT[kind];
            return (
              <li key={kind} className="ep-row">
                <div className="ep-row-main">
                  <label className="e1-switch ep-switch" htmlFor={id}>
                    <input
                      id={id}
                      type="checkbox"
                      role="switch"
                      checked={pref.enabled}
                      aria-checked={pref.enabled}
                      aria-describedby={`${id}-hint${row.error ? ` ${id}-error` : ''}`}
                      aria-busy={row.saving ? true : undefined}
                      disabled={row.saving}
                      onChange={(event) => onToggle(kind, event.target.checked)}
                    />
                    <span>{text.label}</span>
                  </label>
                  <span className={`e1-badge ep-badge${pref.isDefault ? '' : ' active'}`}>
                    {row.saving ? 'Guardando…' : defaultBadge(pref)}
                  </span>
                </div>
                <p id={`${id}-hint`} className="ep-hint">
                  {text.hint} {pref.enabled ? 'Ahora: activado.' : 'Ahora: desactivado.'}
                </p>
                {row.error && <p id={`${id}-error`} className="error ep-error" role="alert">{row.error}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
    </section>
  );
}
