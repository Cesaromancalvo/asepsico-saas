'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import EmailPreferencesPanel, { RowState } from '@/components/EmailPreferencesPanel';
import { useViewer } from '@/lib/clinical';
import {
  EMAIL_KIND_TEXT,
  fetchEmailPreferences,
  loadErrorMessage,
  saveErrorMessage,
  StaffEmailKind,
  StaffEmailPreference,
  updateEmailPreference,
} from '@/lib/email-preferences';

type Prefs = Record<StaffEmailKind, StaffEmailPreference>;

/**
 * Mi cuenta → Avisos por email (N4). Ruta fija: la enlaza el pie de los emails al equipo.
 * Solo las preferencias del propio usuario en su espacio actual; nada de pacientes.
 */
export default function EmailNotificationsPage() {
  const viewer = useViewer();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Partial<Record<StaffEmailKind, RowState>>>({});
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await fetchEmailPreferences();
      setPrefs(result.preferences);
    } catch (err) {
      setLoadError(loadErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggle(kind: StaffEmailKind, enabled: boolean) {
    if (!prefs) return;
    const previous = prefs[kind];
    // Cambio inmediato en pantalla; si la API falla, se vuelve al valor anterior.
    setPrefs((current) => (current ? { ...current, [kind]: { ...current[kind], enabled } } : current));
    setRows((current) => ({ ...current, [kind]: { saving: true } }));
    setStatus('');
    try {
      const result = await updateEmailPreference(kind, enabled);
      // Solo se toma la opción guardada: otra que se esté guardando a la vez no se pisa.
      setPrefs((current) => (current ? { ...current, [kind]: result.preferences[kind] } : current));
      setRows((current) => ({ ...current, [kind]: {} }));
      setStatus(`Guardado: ${EMAIL_KIND_TEXT[kind].label} ${result.preferences[kind].enabled ? 'activado' : 'desactivado'}.`);
    } catch (err) {
      setPrefs((current) => (current ? { ...current, [kind]: previous } : current));
      setRows((current) => ({ ...current, [kind]: { error: saveErrorMessage(kind, err) } }));
    }
  }

  return (
    <div className="app-layout">
      <Sidebar syncText="Avisos por email" />
      <main className="patient-record-page">
        <header className="patient-record-header">
          <div>
            <span className="eyebrow">Mi cuenta</span>
            <h1>Avisos por email</h1>
            <p>Elige qué te avisamos por correo para no perderte nada cuando no tienes AsePsico abierto.</p>
          </div>
        </header>

        {loading && !prefs ? (
          <section className="patient-card" aria-busy="true">
            <p role="status">Cargando tus avisos por email…</p>
          </section>
        ) : loadError ? (
          <section className="patient-card">
            <p className="error" role="alert">{loadError}</p>
            <button type="button" className="button secondary" onClick={() => void load()}>Reintentar</button>
          </section>
        ) : prefs ? (
          <EmailPreferencesPanel
            workspaceName={viewer?.workspaceName ?? null}
            preferences={prefs}
            rows={rows}
            status={status}
            onToggle={(kind, enabled) => void toggle(kind, enabled)}
          />
        ) : null}

        <p className="muted ep-back">
          Los avisos dentro de la app (la campana) siguen llegando igual. <Link href="/settings/security">Volver a Mi cuenta</Link>
        </p>
      </main>
    </div>
  );
}
