'use client';
import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';

type AccessMode = 'PATIENT_ONLY' | 'GUARDIAN_ONLY' | 'SHARED';
type Account = {
  id: string;
  email: string;
  accessorType: 'PATIENT' | 'GUARDIAN';
  guardianName?: string | null;
  guardianRelationship?: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: string | null;
  createdAt: string;
};

const MODE_LABELS: Record<AccessMode, string> = {
  PATIENT_ONLY: 'Solo el paciente',
  GUARDIAN_ONLY: 'Solo su(s) tutor(es)',
  SHARED: 'Paciente y tutor(es), compartido',
};

function formatDate(value?: string | null) {
  if (!value) return 'Nunca';
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export default function PatientPortalAdminPage() {
  const { id } = useParams<{ id: string }>();

  const [accessMode, setAccessMode] = useState<AccessMode>('PATIENT_ONLY');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // Formulario: cuenta del propio paciente
  const [patientEmail, setPatientEmail] = useState('');
  const [patientPassword, setPatientPassword] = useState('');

  // Formulario: cuenta de un tutor
  const [guardianEmail, setGuardianEmail] = useState('');
  const [guardianPassword, setGuardianPassword] = useState('');
  const [guardianName, setGuardianName] = useState('');
  const [guardianRelationship, setGuardianRelationship] = useState('');

  async function load() {
    try {
      setLoading(true);
      setError('');
      const [patient, accountList] = await Promise.all([
        api<{ portalAccessMode?: AccessMode }>(`/patients/${id}`),
        api<Account[]>(`/patients/${id}/portal-accounts`),
      ]);
      setAccessMode(patient.portalAccessMode ?? 'PATIENT_ONLY');
      setAccounts(accountList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la información del portal');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (id) load(); }, [id]);

  async function saveAccessMode(newMode: AccessMode) {
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/patients/${id}`, { method: 'PATCH', body: JSON.stringify({ portalAccessMode: newMode }) });
      setAccessMode(newMode);
      setMessage('Modo de acceso actualizado.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar el modo de acceso');
    } finally {
      setBusy(false);
    }
  }

  async function enablePatientAccount(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/patients/${id}/portal-account`, {
        method: 'POST',
        body: JSON.stringify({ email: patientEmail, temporaryPassword: patientPassword, accessorType: 'PATIENT' }),
      });
      setMessage('Acceso del paciente activado. Entrega la contraseña temporal por un canal seguro.');
      setPatientPassword('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo activar el acceso del paciente');
    } finally {
      setBusy(false);
    }
  }

  async function enableGuardianAccount(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/patients/${id}/portal-account`, {
        method: 'POST',
        body: JSON.stringify({
          email: guardianEmail,
          temporaryPassword: guardianPassword,
          accessorType: 'GUARDIAN',
          guardianName,
          guardianRelationship,
        }),
      });
      setMessage('Acceso del tutor activado. Entrega la contraseña temporal por un canal seguro.');
      setGuardianEmail(''); setGuardianPassword(''); setGuardianName(''); setGuardianRelationship('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo activar el acceso del tutor');
    } finally {
      setBusy(false);
    }
  }

  async function disableAll() {
    if (!confirm('Esto desactiva TODO el acceso al portal de este paciente: su propia cuenta y la de cualquier tutor que tenga. ¿Continuar?')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/patients/${id}/portal-account`, { method: 'DELETE' });
      setMessage('Acceso desactivado para todas las cuentas de este paciente.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo desactivar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="patient-record-page">
        <Link href={`/patients/${id}`} className="patient-record-back">← Volver a la ficha</Link>
        <header className="patient-record-header">
          <div>
            <span className="eyebrow">Portal del paciente</span>
            <h1>Gestionar acceso</h1>
            <p>Activa, restringe o combina el acceso del paciente y de sus tutores, sin exponer información clínica interna.</p>
          </div>
        </header>

        {error && <div className="agenda-error">{error}</div>}
        {message && <div className="patient-save-state">{message}</div>}

        <section className="patient-card">
          <h2>Modo de acceso</h2>
          <p>Decide quién puede tener cuenta en el portal de este paciente — depende de su edad y madurez, según tu criterio clínico.</p>
          <label className="field">
            <select value={accessMode} onChange={(e) => saveAccessMode(e.target.value as AccessMode)} disabled={busy || loading}>
              {(Object.keys(MODE_LABELS) as AccessMode[]).map((mode) => (
                <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>
              ))}
            </select>
          </label>
        </section>

        <section className="patient-card">
          <h2>Cuentas activas hoy</h2>
          {loading ? (
            <p className="muted">Cargando…</p>
          ) : accounts.length === 0 ? (
            <p className="muted">Este paciente todavía no tiene ninguna cuenta de portal creada.</p>
          ) : (
            <div className="billing-list">
              {accounts.map((account) => (
                <article key={account.id} className="billing-row">
                  <div>
                    <strong>
                      {account.accessorType === 'PATIENT' ? 'El propio paciente' : `Tutor: ${account.guardianName || 'sin nombre'} (${account.guardianRelationship || 'relación no indicada'})`}
                    </strong>
                    <small>{account.email} · último acceso: {formatDate(account.lastLoginAt)}</small>
                  </div>
                  <span className={`status-pill ${account.isActive ? 'ready' : 'blocked'}`}>{account.isActive ? 'Activa' : 'Desactivada'}</span>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="patient-card">
          <h2>Activar o restablecer el acceso del paciente</h2>
          <form className="document-form" onSubmit={enablePatientAccount}>
            <label><span>Correo del paciente</span><input type="email" value={patientEmail} onChange={(e) => setPatientEmail(e.target.value)} required /></label>
            <label><span>Contraseña temporal</span><input type="password" value={patientPassword} onChange={(e) => setPatientPassword(e.target.value)} minLength={12} required /><small>Debe incluir mayúscula, minúscula y número.</small></label>
            <button className="button primary" disabled={busy}>Activar / restablecer paciente</button>
          </form>
        </section>

        <section className="patient-card">
          <h2>Añadir o restablecer el acceso de un tutor</h2>
          <form className="document-form" onSubmit={enableGuardianAccount}>
            <label><span>Nombre del tutor</span><input type="text" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} required /></label>
            <label><span>Relación con el paciente</span><input type="text" placeholder="Madre, padre, tutor legal…" value={guardianRelationship} onChange={(e) => setGuardianRelationship(e.target.value)} required /></label>
            <label><span>Correo del tutor</span><input type="email" value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} required /></label>
            <label><span>Contraseña temporal</span><input type="password" value={guardianPassword} onChange={(e) => setGuardianPassword(e.target.value)} minLength={12} required /><small>Debe incluir mayúscula, minúscula y número.</small></label>
            <button className="button primary" disabled={busy}>Activar / restablecer tutor</button>
          </form>
        </section>

        <section className="patient-card">
          <h2>Desactivar todo el acceso</h2>
          <p>Apaga a la vez la cuenta del paciente y la de cualquier tutor. Para quitar solo a una persona concreta sin tocar al resto, habla con soporte técnico — todavía no hay un botón individual para eso.</p>
          <button type="button" className="button secondary" onClick={disableAll} disabled={busy}>Desactivar todo el acceso</button>
        </section>
      </main>
    </div>
  );
}
