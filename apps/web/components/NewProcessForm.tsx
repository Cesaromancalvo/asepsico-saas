'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useId, useState } from 'react';
import { api } from '@/lib/api';
import { isAdminRole, Viewer } from '@/lib/clinical';

type Clinician = { userId: string; firstName: string | null; lastName: string | null; email: string | null; isClinician: boolean };

type Props = {
  patientId: string;
  viewer: Viewer;
  heading?: string;
  submitLabel?: string;
  /** Motivo de consulta ya registrado (solo si la API lo ha servido al usuario). */
  initialReason?: string | null;
  /** Se ejecuta antes de crear el proceso (p. ej. cerrar el anterior). Si lanza, no se crea. */
  beforeCreate?: () => Promise<void>;
  onCreated: (process: { id: string }) => void | Promise<void>;
  onCancel?: () => void;
};

function clinicianName(member: Clinician) {
  return [member.firstName, member.lastName].filter(Boolean).join(' ').trim() || member.email || 'Profesional';
}

/**
 * Abrir un proceso clínico. OWNER/ADMIN eligen al profesional responsable entre quienes atienden
 * pacientes; un terapeuta solo puede abrirlo a su nombre. El contenido clínico (motivo y
 * objetivos) solo se pide cuando el proceso es del propio usuario y atiende pacientes: abrirlo a
 * nombre de otro es una operación administrativa y la API rechazaría ese contenido (403).
 */
export default function NewProcessForm({ patientId, viewer, heading = 'Abrir proceso clínico', submitLabel = 'Crear proceso', initialReason, beforeCreate, onCreated, onCancel }: Props) {
  const ids = useId();
  const isAdmin = isAdminRole(viewer.role);
  const [clinicians, setClinicians] = useState<Clinician[] | null>(isAdmin ? null : []);
  const [therapistId, setTherapistId] = useState<string>(viewer.userId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api<Clinician[]>('/workspace-members')
      .then((members) => {
        if (cancelled) return;
        const list = members.filter((member) => member.isClinician);
        setClinicians(list);
        setTherapistId((current) => (list.some((m) => m.userId === current) ? current : list[0]?.userId ?? ''));
      })
      .catch((err) => {
        if (!cancelled) {
          setClinicians([]);
          setError(err instanceof Error ? err.message : 'No se pudo cargar el equipo');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const ownProcess = isAdmin ? Boolean(viewer.userId) && therapistId === viewer.userId : true;
  const canWriteClinical = ownProcess && viewer.isClinician;
  const noClinicians = isAdmin && clinicians !== null && clinicians.length === 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (isAdmin && !therapistId) {
      setError('Elige el profesional responsable del proceso.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await beforeCreate?.();
      const reason = canWriteClinical ? String(data.get('consultationReason') ?? '').trim() : '';
      const goals = canWriteClinical ? String(data.get('goals') ?? '').trim() : '';
      const created = await api<{ id: string }>('/clinical-processes', {
        method: 'POST',
        body: JSON.stringify({
          patientId,
          ...(isAdmin ? { therapistId } : {}),
          title: String(data.get('title') ?? '').trim() || 'Proceso de intervención',
          ...(reason ? { consultationReason: reason } : {}),
          ...(goals ? { goals } : {}),
          modality: data.get('modality') || 'IN_PERSON',
          frequency: String(data.get('frequency') ?? '').trim() || undefined,
        }),
      });
      form.reset();
      await onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear el proceso');
    } finally {
      setBusy(false);
    }
  }

  if (noClinicians) {
    return (
      <div className="e1-notice" role="note">
        <div>
          <strong>Nadie del equipo atiende pacientes todavía</strong>
          <p>Para abrir un proceso, marca en <Link href="/settings/team">Equipo</Link> quién atiende pacientes.</p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="e1-form" aria-labelledby={`${ids}-heading`}>
      <h3 id={`${ids}-heading`}>{heading}</h3>
      {isAdmin && (
        <label className="field">
          Profesional responsable
          <select value={therapistId} onChange={(event) => setTherapistId(event.target.value)} disabled={clinicians === null} required>
            {clinicians === null && <option value="">Cargando equipo…</option>}
            {(clinicians ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {clinicianName(member)}{member.userId === viewer.userId ? ' (tú)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        Nombre del proceso
        <input name="title" required minLength={2} maxLength={160} defaultValue="Proceso de intervención individual" aria-describedby={`${ids}-title-hint`} />
        <small id={`${ids}-title-hint`} className="muted">Evita datos clínicos en el nombre: se muestra en vistas generales.</small>
      </label>
      {canWriteClinical ? (
        <>
          <label className="field">
            Motivo de consulta
            <input key={`reason-${initialReason ?? ''}`} name="consultationReason" maxLength={4000} defaultValue={initialReason ?? ''} placeholder="Describe el motivo principal de consulta" />
          </label>
          <label className="field">
            Objetivos iniciales
            <textarea name="goals" rows={3} maxLength={6000} />
          </label>
        </>
      ) : (
        <p className="muted">El motivo de consulta y los objetivos los registrará el profesional responsable.</p>
      )}
      <label className="field">
        Modalidad
        <select name="modality" defaultValue="IN_PERSON">
          <option value="IN_PERSON">Presencial</option>
          <option value="ONLINE">Online</option>
          <option value="HYBRID">Híbrida</option>
        </select>
      </label>
      <label className="field">
        Frecuencia
        <input name="frequency" maxLength={120} placeholder="Ej. Semanal" />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="e1-actions">
        <button className="button" type="submit" disabled={busy || (isAdmin && clinicians === null)}>{busy ? 'Guardando…' : submitLabel}</button>
        {onCancel && <button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancelar</button>}
      </div>
    </form>
  );
}
