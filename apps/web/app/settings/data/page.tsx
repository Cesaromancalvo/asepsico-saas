'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';

type Patient = { id: string; firstName: string; lastName: string };
type Check = { key: string; label: string; status: 'READY'|'PENDING'|'WARNING'|'BLOCKED'|'MANUAL'; detail: string };

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

export default function DataSettingsPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState('');
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ data: Patient[] }>('/patients?status=ACTIVE&pageSize=100'),
      api<{ checks: Check[] }>('/exports/pilot-readiness'),
    ]).then(([patientResult, readiness]) => {
      setPatients(patientResult.data); setPatientId(patientResult.data[0]?.id ?? ''); setChecks(readiness.checks);
    }).catch((e) => setError(e.message));
  }, []);

  async function exportPatient() {
    if (!patientId) return;
    setBusy(true); setError('');
    try { const data = await api(`/exports/patients/${patientId}`); downloadJson(`asepsico-paciente-${patientId}.json`, data); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo exportar'); } finally { setBusy(false); }
  }

  async function exportWorkspace() {
    setBusy(true); setError('');
    try { const data = await api('/exports/workspace'); downloadJson(`asepsico-workspace-${new Date().toISOString().slice(0,10)}.json`, data); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo exportar'); } finally { setBusy(false); }
  }

  return <div className="app-layout"><Sidebar/><main className="patient-record-page">
    <header className="patient-record-header"><div><span className="eyebrow">Datos y continuidad</span><h1>Exportaciones y preparación del piloto</h1><p>Descarga información de forma controlada y revisa los puntos operativos antes de incorporar usuarios reales.</p></div></header>
    {error && <div className="agenda-error">{error}</div>}
    <section className="patient-card"><h2>Exportar expediente de un paciente</h2><p>Incluye historia, procesos, sesiones, objetivos, tareas, escalas, consentimientos, informes, documentos, facturas y recursos compartidos.</p>
      <div className="billing-form"><label>Paciente<select value={patientId} onChange={(e)=>setPatientId(e.target.value)}>{patients.map(p=><option value={p.id} key={p.id}>{p.firstName} {p.lastName}</option>)}</select></label><button className="button primary" disabled={busy||!patientId} onClick={exportPatient}>Descargar JSON</button></div>
      <small>El archivo contiene información clínica confidencial. Protégelo fuera de AsePsico.</small>
    </section>
    <section className="patient-card"><h2>Exportación administrativa del workspace</h2><p>Inventario de miembros, pacientes, actividad y últimos eventos de auditoría. Solo disponible para propietario y administración.</p><button className="button" disabled={busy} onClick={exportWorkspace}>Descargar exportación</button></section>
    <section className="patient-card"><h2>Checklist de preparación del piloto</h2><div className="billing-list">{checks.map(check=><article className="billing-row" key={check.key}><div><strong>{check.label}</strong><small>{check.detail}</small></div><span className={`status-pill ${check.status.toLowerCase()}`}>{check.status}</span></article>)}</div></section>
  </main></div>;
}
