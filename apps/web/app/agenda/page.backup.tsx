'use client';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, logout } from '@/lib/api';

type Patient = { id: string; firstName: string; lastName: string };
type Session = { id: string; patientId: string; therapistId: string; startsAt: string; endsAt: string; status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW'; notes?: string };
type Page<T> = { data: T[]; meta: { total: number } };

const STATUS_LABEL: Record<Session['status'], string> = { SCHEDULED: 'Programada', COMPLETED: 'Completada', CANCELLED: 'Cancelada', NO_SHOW: 'No asistió' };

function toLocalInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function AgendaPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState('');

  const rangeFrom = useMemo(() => new Date(new Date().setHours(0, 0, 0, 0)), []);
  const rangeTo = useMemo(() => new Date(rangeFrom.getTime() + 14 * 24 * 60 * 60 * 1000), [rangeFrom]);

  async function load() {
    try {
      setError('');
      const [p, s] = await Promise.all([
        api<Page<Patient>>('/patients?status=ACTIVE&pageSize=100'),
        api<Page<Session>>(`/sessions?from=${rangeFrom.toISOString()}&to=${rangeTo.toISOString()}`),
      ]);
      setPatients(p.data);
      setSessions(s.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }
  useEffect(() => { load(); }, []);

  function patientName(id: string) {
    const p = patients.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : 'Paciente';
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const startsAt = new Date(String(f.get('startsAt')));
    const durationMin = Number(f.get('duration') || 50);
    const endsAt = new Date(startsAt.getTime() + durationMin * 60 * 1000);
    try {
      await api('/sessions', { method: 'POST', body: JSON.stringify({ patientId: f.get('patientId'), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), notes: f.get('notes') || undefined }) });
      e.currentTarget.reset();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la sesión');
    }
  }

  async function close(id: string, status: 'COMPLETED' | 'CANCELLED' | 'NO_SHOW') {
    try { await api(`/sessions/${id}/close`, { method: 'PATCH', body: JSON.stringify({ status }) }); load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'No se pudo actualizar la sesión'); }
  }

  const byDay = useMemo(() => {
    const groups = new Map<string, Session[]>();
    for (const s of [...sessions].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      const day = new Date(s.startsAt).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
      groups.set(day, [...(groups.get(day) ?? []), s]);
    }
    return groups;
  }, [sessions]);

  return (
    <main className="shell">
      <nav className="nav">
        <div>
          <div className="brand">AsePsico</div>
          <span className="muted">Agenda</span>
          <Link href="/patients" className="button secondary" style={{ marginLeft: 12 }}>Pacientes</Link>
        </div>
        <button className="button secondary" onClick={() => { logout().finally(() => { location.href = '/login'; }); }}>Salir</button>
      </nav>
      {error && <p className="error">{error}</p>}
      <div className="grid">
        <section className="card">
          <h2>Próximas dos semanas</h2>
          <div className="stack">
            {[...byDay.entries()].map(([day, items]) => (
              <div key={day}>
                <h3 style={{ textTransform: 'capitalize' }}>{day}</h3>
                {items.map((s) => (
                  <article className="patient" key={s.id}>
                    <div>
                      <strong>{new Date(s.startsAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} · {patientName(s.patientId)}</strong>
                      <div className="muted">{s.notes || 'Sin notas'} · {STATUS_LABEL[s.status]}</div>
                    </div>
                    {s.status === 'SCHEDULED' && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="button secondary" onClick={() => close(s.id, 'COMPLETED')}>Completar</button>
                        <button className="button secondary" onClick={() => close(s.id, 'NO_SHOW')}>No asistió</button>
                        <button className="button secondary" onClick={() => close(s.id, 'CANCELLED')}>Cancelar</button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ))}
            {sessions.length === 0 && <p className="muted">No hay sesiones en los próximos 14 días.</p>}
          </div>
        </section>
        <section className="card">
          <h2>Nueva sesión</h2>
          <form onSubmit={create}>
            <label className="field">
              Paciente
              <select name="patientId" required defaultValue="">
                <option value="" disabled>Selecciona un paciente</option>
                {patients.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
              </select>
            </label>
            <label className="field">Fecha y hora<input name="startsAt" type="datetime-local" defaultValue={toLocalInput(new Date())} required /></label>
            <label className="field">Duración (minutos)<input name="duration" type="number" defaultValue={50} min={15} max={240} /></label>
            <label className="field">Notas<input name="notes" /></label>
            <button className="button">Agendar</button>
          </form>
        </section>
      </div>
    </main>
  );
}
