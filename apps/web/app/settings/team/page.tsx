'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';
import { invalidateViewer, isForbidden, ROLE_LABEL, StaffRole, useViewer } from '@/lib/clinical';

/** Fila de GET /workspace-members (datos administrativos, sin nada clínico). */
type Member = {
  id: string;
  userId: string;
  role: StaffRole;
  isClinician: boolean;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};

function memberName(member: Member) {
  return [member.firstName, member.lastName].filter(Boolean).join(' ').trim() || member.email || 'Miembro sin nombre';
}

export default function TeamPage() {
  const viewer = useViewer();
  const [members, setMembers] = useState<Member[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [savingUserId, setSavingUserId] = useState<string | null>(null);

  async function load() {
    try {
      setState('loading');
      setError('');
      setMembers(await api<Member[]>('/workspace-members'));
      setState('ready');
    } catch (err) {
      if (isForbidden(err)) {
        setState('forbidden');
        return;
      }
      setError(err instanceof Error ? err.message : 'No se pudo cargar el equipo');
      setState('error');
    }
  }

  useEffect(() => {
    load();
  }, []);

  const isOwner = viewer?.role === 'OWNER';

  async function toggleClinician(member: Member, next: boolean) {
    setSavingUserId(member.userId);
    setError('');
    setStatus('');
    try {
      const saved = await api<Member>(`/workspace-members/${member.userId}/clinician`, {
        method: 'PATCH',
        body: JSON.stringify({ isClinician: next }),
      });
      setMembers((current) => current.map((row) => (row.userId === saved.userId ? { ...row, ...saved } : row)));
      if (saved.userId === viewer?.userId) invalidateViewer();
      setStatus(`${memberName(saved)} ${saved.isClinician ? 'ahora atiende pacientes' : 'ya no atiende pacientes'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el cambio');
    } finally {
      setSavingUserId(null);
    }
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="patient-record-page">
        <header className="patient-record-header">
          <div>
            <span className="eyebrow">Consulta</span>
            <h1>Equipo</h1>
            <p>Quién forma parte de la consulta y quién atiende pacientes.</p>
          </div>
        </header>

        <div className="e1-notice info" role="note">
          <div>
            <strong>Qué significa «Atiende pacientes»</strong>
            <p>
              Indica que esa persona es profesional clínico. Por sí solo no le da acceso a ningún paciente: solo verá
              el contenido clínico de los pacientes con los que tenga un proceso activo. Los terapeutas siempre
              atienden pacientes y los asistentes nunca. Solo la persona titular de la consulta puede cambiarlo.
            </p>
          </div>
        </div>

        {error && <div className="agenda-error" role="alert">{error}</div>}
        <p className={status ? 'patient-save-state' : undefined} role="status" aria-live="polite">{status}</p>

        {state === 'loading' && <div className="patient-record-loading">Cargando equipo…</div>}

        {state === 'forbidden' && (
          <section className="patient-record-card">
            <h2>Sin acceso a esta sección</h2>
            <p>La gestión del equipo está disponible para la persona titular y para administración.</p>
          </section>
        )}

        {state === 'error' && (
          <section className="patient-record-card">
            <p>No se ha podido cargar el equipo.</p>
            <button type="button" className="button secondary" onClick={load}>Reintentar</button>
          </section>
        )}

        {state === 'ready' && (
          <section className="patient-record-card">
            <h2>Miembros ({members.length})</h2>
            {members.length === 0 ? (
              <p className="muted">Todavía no hay miembros en la consulta.</p>
            ) : (
              <ul className="e1-list">
                {members.map((member) => {
                  const configurable = member.role === 'OWNER' || member.role === 'ADMIN';
                  const switchId = `clinician-${member.userId}`;
                  const hintId = `${switchId}-hint`;
                  return (
                    <li key={member.id} className="e1-row">
                      <div>
                        <strong>
                          {memberName(member)}
                          {member.userId === viewer?.userId ? ' (tú)' : ''}
                        </strong>
                        {member.email && <small>{member.email}</small>}
                      </div>
                      <div>
                        <span className="e1-badge">{ROLE_LABEL[member.role] ?? member.role}</span>
                      </div>
                      <div>
                        {configurable ? (
                          <>
                            <label className="e1-switch" htmlFor={switchId}>
                              <input
                                id={switchId}
                                type="checkbox"
                                role="switch"
                                checked={member.isClinician}
                                aria-checked={member.isClinician}
                                aria-describedby={hintId}
                                disabled={!isOwner || savingUserId !== null}
                                onChange={(event) => toggleClinician(member, event.target.checked)}
                              />
                              Atiende pacientes
                            </label>
                            <small id={hintId}>
                              {savingUserId === member.userId
                                ? 'Guardando…'
                                : isOwner
                                  ? member.isClinician ? 'Sí' : 'No'
                                  : 'Solo la persona titular puede cambiarlo'}
                            </small>
                          </>
                        ) : (
                          <small>
                            {member.role === 'THERAPIST' ? 'Siempre atiende pacientes' : 'No atiende pacientes'}
                          </small>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
