'use client';

import { notFound } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PlatformWaitlistResponse } from '@asepsico/contracts';
import Sidebar from '@/components/Sidebar';
import Icon, { EmptyState } from '@/components/Icon';
import WaitlistSuppressDialog from '@/components/WaitlistSuppressDialog';
import { Counters, EntriesTable, EntryCard, FiltersBar } from '@/components/WaitlistPanelParts';
import {
  applyFilters, EMPTY_FILTERS, Entry, fieldView, Filters, formatSignupDate, hasFilters, loadPanel, plural, suppressEntry,
  suppressErrorMessage, weekOptions, withoutEntry,
} from '@/lib/platform-waitlist';

type State = 'loading' | 'ready' | 'error' | 'notFound';
type Target = { id: string; label: string; detail: string };

/**
 * Panel privado de la lista de espera (solo PLATFORM_ADMIN; spec de Vega, MVP).
 * Lista + contadores + filtros en el navegador + supresión con contraseña. Sin exportar ni copiar
 * en bloque. Los datos solo viven en memoria: nada en storage ni en la URL (los filtros tampoco).
 */
export default function WaitlistPanelPage() {
  const [state, setState] = useState<State>('loading');
  const [data, setData] = useState<PlatformWaitlistResponse | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [target, setTarget] = useState<Target | null>(null);
  const [status, setStatus] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (initial: boolean) => {
    if (initial) setState('loading'); else setRefreshing(true);
    try {
      const result = await loadPanel();
      if (result.kind === 'notFound') { setData(null); setState('notFound'); return; }
      setData(result.data);
      setState('ready');
    } catch {
      if (initial) setState('error');
      else setStatus('No se ha podido actualizar la lista. Se muestran los datos anteriores.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(true); }, [load]);

  const entries = data?.entries ?? [];
  const visible = useMemo(() => applyFilters(entries, filters), [entries, filters]);
  const weeks = useMemo(() => weekOptions(entries), [entries]);
  const filtered = hasFilters(filters);

  if (state === 'notFound') notFound();

  async function confirmSuppress(id: string, password: string): Promise<string | null> {
    try {
      await suppressEntry(id, password);
      setData((current) => (current ? withoutEntry(current, id) : current));
      setStatus('Alta suprimida. Ya no aparece en la lista y los contadores se han actualizado.');
      return null;
    } catch (err) {
      return suppressErrorMessage(err);
    }
  }

  function openSuppress(entry: Entry) {
    const name = fieldView(entry, 'name');
    setStatus('');
    setTarget({
      id: entry.id,
      label: name.unreadable || name.text === '—' ? 'Alta sin nombre legible' : name.text,
      detail: `Alta del ${formatSignupDate(entry.createdAt)} · ${entry.privacyPolicyVersion}`,
    });
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="dashboard wl-page">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Administración</p>
            <h1>Lista de espera</h1>
            <p className="dashboard-subtitle">Profesionales que se han apuntado desde asepsico.es. Las altas suprimidas no aparecen.</p>
          </div>
          {state === 'ready' && (
            <div className="dashboard-actions">
              <button type="button" className="agenda-navigation-button" disabled={refreshing} onClick={() => void load(false)}>
                <Icon name="clock" size={18} />{refreshing ? 'Actualizando…' : 'Actualizar'}
              </button>
            </div>
          )}
        </header>

        <p className="wl-notice" role="note">
          <Icon name="lock" size={18} />
          <span><strong>Lista de espera · solo para administración de AsePsico.</strong> No contiene datos clínicos. No copies estos datos fuera del panel.</span>
        </p>

        <p className={status ? 'patient-save-state wl-status' : 'bk-live'} role="status" aria-live="polite">{status}</p>

        {state === 'loading' && <section className="dashboard-card dashboard-loading" role="status">Cargando la lista de espera…</section>}

        {state === 'error' && (
          <section className="dashboard-card dashboard-error" role="alert">
            <p>No se ha podido cargar la lista de espera. Comprueba la conexión y vuelve a intentarlo.</p>
            <button type="button" className="button secondary" onClick={() => void load(true)}>Intentar de nuevo</button>
          </section>
        )}

        {state === 'ready' && data && (
          <>
            <Counters data={data} />

            {entries.length === 0 ? (
              <section className="dashboard-card wl-empty-card">
                <EmptyState icon="inbox" title="Todavía no hay nadie en la lista">
                  Cuando alguien se apunte desde el formulario de asepsico.es aparecerá aquí, con la fecha y cómo os ha conocido.
                </EmptyState>
              </section>
            ) : (
              <section className="dashboard-card wl-list-card" aria-labelledby="wl-list-title">
                <div className="wl-list-head">
                  <div>
                    <h2 id="wl-list-title">Altas</h2>
                    <p className="wl-count" aria-live="polite">
                      {filtered ? <><strong>{visible.length}</strong> de {plural(entries.length, 'alta', 'altas')}</> : plural(entries.length, 'alta activa', 'altas activas')}
                    </p>
                  </div>
                  {filtered && <button type="button" className="text-link wl-clear" onClick={() => setFilters(EMPTY_FILTERS)}>Quitar filtros</button>}
                </div>

                <FiltersBar filters={filters} weeks={weeks} onChange={setFilters} counts={data.counters} />

                {visible.length === 0 ? (
                  <EmptyState icon="info" title="Ningún alta cumple estos filtros" compact>
                    Prueba con otra semana u otro origen, o quita los filtros para ver todas.
                  </EmptyState>
                ) : (
                  <>
                    <EntriesTable entries={visible} onSuppress={openSuppress} />
                    <ul className="wl-cards" aria-label="Altas">
                      {visible.map((entry) => <EntryCard key={entry.id} entry={entry} onSuppress={openSuppress} />)}
                    </ul>
                  </>
                )}
                <p className="wl-generated">Datos generados el {formatSignupDate(data.generatedAt)} (hora de Madrid).</p>
              </section>
            )}
          </>
        )}

        <WaitlistSuppressDialog target={target} onConfirm={confirmSuppress} onClose={() => setTarget(null)} />
      </main>
    </div>
  );
}
