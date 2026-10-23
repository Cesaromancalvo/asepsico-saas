'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import TeamInvites from '@/components/TeamInvites';
import MemberRemovalDialog, { RemovalTarget } from '@/components/MemberRemovalDialog';
import { api } from '@/lib/api';
import { invalidateViewer, isForbidden, ROLE_LABEL, StaffRole, useViewer } from '@/lib/clinical';
import { canRemoveMember } from '@/lib/member-removal';

/** Fila de GET /workspace-members (datos administrativos, sin nada clínico). */
type Member = {
  id: string;
  userId: string;
  role: StaffRole;
  isClinician: boolean;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  status?: 'ACTIVE' | 'REMOVED';
  removedAt?: string | null;
};

function formatDay(value: string) {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
}

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
  const [removal, setRemoval] = useState<RemovalTarget | null>(null);

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
  const activeMembers = members.filter((member) => member.status !== 'REMOVED');
  const removedMembers = members.filter((member) => member.status === 'REMOVED');
  const canManageTeam = viewer?.role === 'OWNER' || viewer?.role === 'ADMIN';

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
            <p>Quién forma parte de la consulta, quién atiende pacientes y a quién has invitado.</p>
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
            <h2>Miembros ({activeMembers.length})</h2>
            {activeMembers.length === 0 ? (
              <p className="muted">Todavía no hay miembros en la consulta.</p>
            ) : (
              <ul className="e1-list">
                {activeMembers.map((member) => {
                  const configurable = member.role === 'OWNER' || member.role === 'ADMIN';
                  const switchId = `clinician-${member.userId}`;
                  const hintId = `${switchId}-hint`;
                  const removable = canRemoveMember(viewer, member);
                  return (
                    <li key={member.id} className="e1-row mr-row">
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
                      <div className="mr-row-actions">
                        {removable && (
                          <button
                            type="button"
                            className="bk-link-button ps-reject"
                            onClick={() => setRemoval({ userId: member.userId, name: memberName(member), mode: 'remove' })}
                            aria-label={`Dar de baja a ${memberName(member)}`}
                          >
                            Dar de baja
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {state === 'ready' && removedMembers.length > 0 && (
          <section className="patient-record-card" aria-labelledby="removed-title">
            <h2 id="removed-title">Dados de baja ({removedMembers.length})</h2>
            <p className="muted">
              Ya no tienen acceso. Lo que escribieron sigue en la consulta con su nombre y sus notas internas no las ve nadie más.
            </p>
            <ul className="e1-list">
              {removedMembers.map((member) => {
                const clinical = member.role === 'THERAPIST' || member.isClinician;
                return (
                  <li key={member.id} className="e1-row mr-row is-removed">
                    <div>
                      <strong>{memberName(member)}</strong>
                      {member.email && <small>{member.email}</small>}
                    </div>
                    <div>
                      <span className="e1-badge">{ROLE_LABEL[member.role] ?? member.role}</span>
                    </div>
                    <div>
                      <span className="ui-chip chip-neutral">{member.removedAt ? `De baja desde el ${formatDay(member.removedAt)}` : 'De baja'}</span>
                    </div>
                    <div className="mr-row-actions">
                      {canManageTeam && clinical && (viewer?.role === 'OWNER' || member.role === 'THERAPIST') && (
                        <button
                          type="button"
                          className="button secondary small-secondary"
                          onClick={() => setRemoval({ userId: member.userId, name: memberName(member), mode: 'reassign' })}
                          aria-label={`Ver y pasar el trabajo pendiente de ${memberName(member)}`}
                        >
                          Trabajo pendiente
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {state === 'ready' && viewer && <TeamInvites isOwner={isOwner} />}

        <MemberRemovalDialog
          target={removal}
          onClose={() => setRemoval(null)}
          onDone={(message) => { setStatus(message); void load(); }}
        />
      </main>
    </div>
  );
}
