'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { CreatedMemberInviteContract, InvitableRole, MemberInviteContract } from '@asepsico/contracts';
import { api, ApiError } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/clinical';

const INVITABLE_ROLES: InvitableRole[] = ['THERAPIST', 'ASSISTANT', 'ADMIN'];

const ROLE_HINT: Record<InvitableRole, string> = {
  THERAPIST: 'Atiende pacientes. Solo verá el contenido clínico de los pacientes con los que tenga un proceso activo.',
  ASSISTANT: 'Gestiona agenda y datos administrativos. Nunca accede a contenido clínico.',
  ADMIN: 'Gestiona la consulta y el equipo. Puede atender pacientes o no, según marques abajo.',
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
}

function isPending(invite: MemberInviteContract) {
  return !invite.acceptedAt && !invite.revokedAt && new Date(invite.expiresAt).getTime() > Date.now();
}

/**
 * Invitaciones de miembros. Crear y revocar: solo la persona titular (la API lo comprueba).
 * Administración ve las pendientes. El enlace solo se muestra una vez, al crearlo.
 */
export default function TeamInvites({ isOwner, onChanged }: { isOwner: boolean; onChanged?: () => void }) {
  const [invites, setInvites] = useState<MemberInviteContract[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'hidden' | 'error'>('loading');
  const [role, setRole] = useState<InvitableRole>('THERAPIST');
  const [adminClinician, setAdminClinician] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [created, setCreated] = useState<CreatedMemberInviteContract | null>(null);
  const [copyState, setCopyState] = useState('');
  const [listError, setListError] = useState('');
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const createdHeadingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    try {
      setState('loading');
      setInvites(await api<MemberInviteContract[]>('/workspace-members/invites'));
      setState('ready');
    } catch (err) {
      setState(err instanceof ApiError && err.status === 403 ? 'hidden' : 'error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (created) createdHeadingRef.current?.focus();
  }, [created]);

  const isClinician = role === 'THERAPIST' ? true : role === 'ASSISTANT' ? false : adminClinician;

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    setCopyState('');
    const form = event.currentTarget;
    const email = String(new FormData(form).get('email') ?? '').trim();
    setBusy(true);
    try {
      const result = await api<CreatedMemberInviteContract>('/workspace-members/invites', {
        method: 'POST',
        body: JSON.stringify({ email, role, isClinician }),
      });
      setCreated(result);
      form.reset();
      setRole('THERAPIST');
      setAdminClinician(false);
      await load();
      onChanged?.();
    } catch (err) {
      setFormError(err instanceof Error && err.message ? err.message : 'No se ha podido crear la invitación.');
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.inviteUrl);
      setCopyState('Enlace copiado.');
    } catch {
      linkRef.current?.select();
      setCopyState('No se ha podido copiar automáticamente: el enlace está seleccionado, cópialo con Ctrl+C o Cmd+C.');
    }
  }

  async function revoke(invite: MemberInviteContract) {
    if (!window.confirm(`¿Revocar la invitación a ${invite.email}? El enlace dejará de funcionar.`)) return;
    setRevokingId(invite.id);
    setListError('');
    try {
      await api(`/workspace-members/invites/${encodeURIComponent(invite.id)}`, { method: 'DELETE' });
      if (created?.id === invite.id) setCreated(null);
      await load();
    } catch (err) {
      setListError(err instanceof Error && err.message ? err.message : 'No se ha podido revocar la invitación.');
    } finally {
      setRevokingId(null);
    }
  }

  if (state === 'hidden') return null;
  const pending = invites.filter(isPending);

  return (
    <>
      {isOwner && (
        <section className="patient-record-card" aria-labelledby="invite-title">
          <h2 id="invite-title">Invitar a alguien al equipo</h2>
          <p className="muted">
            Se genera un enlace personal que caduca a los 14 días. Envíalo tú por un canal privado; solo funciona con el
            correo indicado.
          </p>
          <form onSubmit={createInvite} className="e1-form" style={{ maxWidth: 'none' }}>
            <div className="invite-form-grid">
              <label className="field">
                Correo de la persona
                <input name="email" type="email" autoComplete="off" required maxLength={254} />
              </label>
              <label className="field">
                Rol
                <select name="role" value={role} onChange={(event) => setRole(event.target.value as InvitableRole)} aria-describedby="invite-role-hint">
                  {INVITABLE_ROLES.map((value) => (
                    <option key={value} value={value}>{ROLE_LABEL[value]}</option>
                  ))}
                </select>
              </label>
            </div>
            <small id="invite-role-hint" className="muted" style={{ marginTop: -8, marginBottom: 12 }}>{ROLE_HINT[role]}</small>
            <div className="e1-checkbox">
              <input
                id="invite-is-clinician"
                type="checkbox"
                checked={isClinician}
                disabled={role !== 'ADMIN' || busy}
                onChange={(event) => setAdminClinician(event.target.checked)}
                aria-describedby="invite-clinician-hint"
              />
              <span>
                <label htmlFor="invite-is-clinician">Atiende pacientes</label>
                <small id="invite-clinician-hint">
                  {role === 'THERAPIST' && 'Un terapeuta siempre atiende pacientes.'}
                  {role === 'ASSISTANT' && 'Un asistente nunca atiende pacientes.'}
                  {role === 'ADMIN' && 'Márcalo solo si esta persona también va a atender pacientes.'}
                </small>
              </span>
            </div>
            {formError && <p className="error" role="alert">{formError}</p>}
            <div>
              <button className="button" type="submit" disabled={busy}>{busy ? 'Creando invitación…' : 'Crear invitación'}</button>
            </div>
          </form>

          {created && (
            <div className="e1-notice info invite-link-box" role="region" aria-labelledby="invite-created-title">
              <div style={{ width: '100%' }}>
                <h3 id="invite-created-title" tabIndex={-1} ref={createdHeadingRef} style={{ margin: '0 0 4px' }}>
                  Invitación creada para {created.email}
                </h3>
                <p><strong>Copia el enlace ahora: no se volverá a mostrar.</strong> Si lo pierdes, crea una invitación nueva (la anterior quedará revocada).</p>
                <div className="invite-link-row" style={{ marginTop: 10 }}>
                  <label htmlFor="invite-url" className="sr-only">Enlace de invitación</label>
                  <input id="invite-url" ref={linkRef} readOnly value={created.inviteUrl} onFocus={(event) => event.currentTarget.select()} />
                  <button type="button" className="button" onClick={copyLink}>Copiar enlace</button>
                  <button type="button" className="button secondary" onClick={() => { setCreated(null); setCopyState(''); }}>Hecho</button>
                </div>
                <p role="status" aria-live="polite" style={{ marginTop: 6 }}>{copyState}</p>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="patient-record-card" aria-labelledby="pending-invites-title">
        <h2 id="pending-invites-title">Invitaciones pendientes{state === 'ready' ? ` (${pending.length})` : ''}</h2>
        {listError && <p className="error" role="alert">{listError}</p>}
        {state === 'loading' && <p className="muted" role="status">Cargando invitaciones…</p>}
        {state === 'error' && (
          <div role="alert">
            <p>No se han podido cargar las invitaciones.</p>
            <button type="button" className="button secondary" onClick={load}>Reintentar</button>
          </div>
        )}
        {state === 'ready' && pending.length === 0 && <p className="muted">No hay invitaciones pendientes.</p>}
        {state === 'ready' && pending.length > 0 && (
          <ul className="e1-list">
            {pending.map((invite) => (
              <li key={invite.id} className="e1-row">
                <div>
                  <strong>{invite.email}</strong>
                  <small>Caduca el {formatDate(invite.expiresAt)}</small>
                </div>
                <div>
                  <span className="e1-badge">{ROLE_LABEL[invite.role] ?? invite.role}</span>
                  <small>{invite.isClinician ? 'Atiende pacientes' : 'No atiende pacientes'}</small>
                </div>
                <div>
                  {isOwner ? (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => revoke(invite)}
                      disabled={revokingId !== null}
                      aria-label={`Revocar la invitación a ${invite.email}`}
                    >
                      {revokingId === invite.id ? 'Revocando…' : 'Revocar'}
                    </button>
                  ) : (
                    <small>Solo la persona titular puede revocarla</small>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
