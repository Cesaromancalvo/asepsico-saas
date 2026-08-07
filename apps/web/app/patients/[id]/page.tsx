'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';

type PatientStatus = 'ACTIVE' | 'PAUSED' | 'DISCHARGED' | 'ARCHIVED';
type GoalStatus = 'ACTIVE' | 'ACHIEVED' | 'PAUSED' | 'CANCELLED';
type TaskStatus = 'DRAFT' | 'PENDING' | 'IN_PROGRESS' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'COMPLETED' | 'CANCELLED';

type Session = { id:string; startsAt:string; endsAt:string; status:string; type:string; notes?:string|null };
type ClinicalProcess = { id:string; title:string; status:string; consultationReason?:string|null; goals?:string|null; modality?:string|null; frequency?:string|null };
type Goal = { id:string; title:string; description?:string|null; status:GoalStatus; targetDate?:string|null; priority:number; updatedAt:string };
type Task = { id:string; title:string; instructions?:string|null; status:TaskStatus; dueDate?:string|null; completedAt?:string|null; patientFeedback?:string|null; clinicianNotes?:string|null; createdAt:string; updatedAt:string };
type Assessment = { id:string; scaleName:string; totalScore:number; severity:string; riskFlag:boolean; administeredAt:string };
type DocumentItem = { id:string; title:string; type:string; createdAt:string };
type TimelineEvent = { id:string; type:string; date:string; title:string; description?:string|null; status?:string|null; href?:string|null };

type Patient = {
  id:string; firstName:string; lastName:string; email?:string|null; phone?:string|null; birthDate?:string|null;
  consultationReason?:string|null; status:PatientStatus; sessions:Session[]; clinicalProcesses:ClinicalProcess[];
  summary:{ processCount:number; sessionCount:number; activeProcess:ClinicalProcess|null; lastSession:Session|null; nextSession:Session|null };
};

type ClinicalHistory = {
  patientId:string; reasonForConsultation:string|null; currentProblem:string|null; personalHistory:string|null;
  familyHistory:string|null; medicalHistory:string|null; currentMedication:string|null; primaryDiagnosis:string|null;
  riskFactors:string|null; protectiveFactors:string|null; clinicalObservations:string|null; updatedAt?:string|null;
};

const EMPTY_HISTORY: ClinicalHistory = {
  patientId:'', reasonForConsultation:'', currentProblem:'', personalHistory:'', familyHistory:'', medicalHistory:'',
  currentMedication:'', primaryDiagnosis:'', riskFactors:'', protectiveFactors:'', clinicalObservations:'', updatedAt:null,
};

const STATUS_LABEL: Record<PatientStatus,string> = { ACTIVE:'Activo', PAUSED:'Pausado', DISCHARGED:'Alta', ARCHIVED:'Archivado' };
const EVENT_LABEL: Record<string,string> = { SESSION:'Sesión', GOAL:'Objetivo', TASK:'Tarea', ASSESSMENT:'Escala', DOCUMENT:'Documento', HISTORY:'Historia', PROCESS:'Proceso', CONSENT:'Consentimiento', REPORT:'Informe', RESOURCE:'Recurso', PATIENT_CREATED:'Alta' };

function formatDate(value?:string|null, includeTime=false) {
  if (!value) return 'Sin registrar';
  return new Intl.DateTimeFormat('es-ES',{ day:'2-digit', month:'short', year:'numeric', ...(includeTime?{hour:'2-digit',minute:'2-digit'}:{}) }).format(new Date(value));
}
function calculateAge(birthDate?:string|null) {
  if (!birthDate) return null;
  const today=new Date(); const birth=new Date(birthDate); let age=today.getFullYear()-birth.getFullYear();
  const month=today.getMonth()-birth.getMonth(); if(month<0||(month===0&&today.getDate()<birth.getDate())) age-=1; return age;
}

export default function PatientRecordPage(){
  const { id:patientId }=useParams<{id:string}>();
  const [patient,setPatient]=useState<Patient|null>(null);
  const [history,setHistory]=useState<ClinicalHistory>(EMPTY_HISTORY);
  const [goals,setGoals]=useState<Goal[]>([]);
  const [tasks,setTasks]=useState<Task[]>([]);
  const [assessments,setAssessments]=useState<Assessment[]>([]);
  const [documents,setDocuments]=useState<DocumentItem[]>([]);
  const [timeline,setTimeline]=useState<TimelineEvent[]>([]);
  const [view,setView]=useState<'overview'|'history'>('overview');
  const [loading,setLoading]=useState(true); const [saving,setSaving]=useState(false); const [error,setError]=useState(''); const [savedMessage,setSavedMessage]=useState('');

  async function load(){
    try{
      setLoading(true); setError('');
      const [patientData,historyData,goalData,taskData,assessmentData,documentData,timelineData]=await Promise.all([
        api<Patient>(`/patients/${patientId}`), api<ClinicalHistory>(`/patients/${patientId}/history`),
        api<Goal[]>(`/patients/${patientId}/goals`), api<Task[]>(`/patients/${patientId}/tasks`),
        api<Assessment[]>(`/patients/${patientId}/assessments`), api<DocumentItem[]>(`/patients/${patientId}/documents`),
        api<TimelineEvent[]>(`/patients/${patientId}/timeline`),
      ]);
      setPatient(patientData); setHistory({...EMPTY_HISTORY,...historyData,patientId}); setGoals(goalData); setTasks(taskData);
      setAssessments(assessmentData); setDocuments(documentData); setTimeline(timelineData);
    }catch(err){ setError(err instanceof Error?err.message:'No se pudo cargar la ficha del paciente'); }
    finally{ setLoading(false); }
  }
  useEffect(()=>{ if(patientId) load(); },[patientId]);

  const age=useMemo(()=>calculateAge(patient?.birthDate),[patient?.birthDate]);
  const activeGoals=useMemo(()=>goals.filter(goal=>goal.status==='ACTIVE').sort((a,b)=>a.priority-b.priority),[goals]);
  const pendingTasks=useMemo(()=>tasks.filter(task=>['PENDING','IN_PROGRESS','CHANGES_REQUESTED'].includes(task.status)).sort((a,b)=>{
    if(!a.dueDate) return 1; if(!b.dueDate) return -1; return new Date(a.dueDate).getTime()-new Date(b.dueDate).getTime();
  }),[tasks]);
  const deliveredTasks=useMemo(()=>tasks.filter(task=>task.status==='SUBMITTED'),[tasks]);
  const latestAssessment=assessments[0];
  const recentTimeline=timeline.slice(0,6);
  const nextAction=deliveredTasks[0]
    ? { title:'Revisar una tarea entregada', detail:deliveredTasks[0].title, href:`/patients/${patientId}/tasks`, cta:'Revisar tarea' }
    : pendingTasks[0]
      ? { title:'Seguimiento entre sesiones', detail:`${pendingTasks[0].title}${pendingTasks[0].dueDate?` · vence ${formatDate(pendingTasks[0].dueDate)}`:''}`, href:`/patients/${patientId}/tasks`, cta:'Abrir tareas' }
      : patient?.summary.nextSession
        ? { title:'Preparar la próxima sesión', detail:formatDate(patient.summary.nextSession.startsAt,true), href:`/agenda/${patient.summary.nextSession.id}`, cta:'Abrir sesión' }
        : { title:'Programar el siguiente paso', detail:'No hay una cita ni una tarea pendiente.', href:`/agenda?patientId=${patientId}`, cta:'Programar cita' };

  function updateField(field:keyof ClinicalHistory,value:string){ setHistory(current=>({...current,[field]:value})); setSavedMessage('Cambios sin guardar'); }
  async function saveHistory(event?:FormEvent){
    event?.preventDefault();
    try{
      setSaving(true); setError(''); const {patientId:_patientId,updatedAt:_updatedAt,...payload}=history;
      const saved=await api<ClinicalHistory>(`/patients/${patientId}/history`,{method:'PATCH',body:JSON.stringify(payload)});
      setHistory({...EMPTY_HISTORY,...saved}); setSavedMessage('Historia clínica guardada'); window.setTimeout(()=>setSavedMessage(''),2500);
    }catch(err){ setError(err instanceof Error?err.message:'No se pudo guardar la historia clínica'); }
    finally{ setSaving(false); }
  }

  if(loading) return <div className="app-layout"><Sidebar/><main className="patient-record-page"><div className="patient-record-loading">Cargando ficha unificada…</div></main></div>;
  if(!patient) return <div className="app-layout"><Sidebar/><main className="patient-record-page"><div className="agenda-error">{error||'Paciente no encontrado'}</div><Link href="/patients" className="button secondary">Volver a pacientes</Link></main></div>;

  return <div className="app-layout"><Sidebar syncText={savedMessage||'Ficha clínica protegida'}/><main className="patient-record-page patient-unified-page">
    <header className="patient-record-header patient-unified-header">
      <div>
        <Link href="/patients" className="patient-record-back">← Volver a pacientes</Link>
        <div className="patient-record-title-row"><div className="patient-record-avatar">{patient.firstName[0]}{patient.lastName[0]}</div><div>
          <div className="patient-record-kicker">Ficha unificada</div><h1>{patient.firstName} {patient.lastName}</h1>
          <div className="patient-record-meta"><span className={`patient-status patient-status-${patient.status.toLowerCase()}`}>{STATUS_LABEL[patient.status]}</span>{age!==null&&<span>{age} años</span>}{patient.email&&<span>{patient.email}</span>}{patient.phone&&<span>{patient.phone}</span>}</div>
        </div></div>
      </div>
      <div className="patient-record-actions"><Link href={`/agenda?patientId=${patient.id}`} className="button">Nueva cita</Link><Link href={`/patients/${patient.id}/tasks`} className="button secondary">Nueva tarea</Link></div>
    </header>

    {error&&<div className="agenda-error">{error}</div>}
    <nav className="patient-unified-tabs" aria-label="Secciones de la ficha"><button className={view==='overview'?'active':''} onClick={()=>setView('overview')}>Resumen y seguimiento</button><button className={view==='history'?'active':''} onClick={()=>setView('history')}>Historia clínica</button></nav>

    {view==='overview' ? <>
      <section className="patient-next-action"><div><span>Siguiente acción recomendada</span><h2>{nextAction.title}</h2><p>{nextAction.detail}</p></div><Link href={nextAction.href} className="button">{nextAction.cta}</Link></section>

      <section className="patient-record-summary-grid patient-unified-summary">
        <article className="patient-summary-card"><span>Próxima sesión</span><strong>{formatDate(patient.summary.nextSession?.startsAt,true)}</strong><small>{patient.summary.nextSession?'Cita programada':'Sin cita prevista'}</small></article>
        <article className="patient-summary-card"><span>Objetivos activos</span><strong>{activeGoals.length}</strong><small>{activeGoals[0]?.title||'Sin objetivos definidos'}</small></article>
        <article className="patient-summary-card"><span>Tareas abiertas</span><strong>{pendingTasks.length}</strong><small>{deliveredTasks.length?`${deliveredTasks.length} pendiente de revisión`:'Sin entregas por revisar'}</small></article>
        <article className="patient-summary-card"><span>Última escala</span><strong>{latestAssessment?`${latestAssessment.scaleName} · ${latestAssessment.totalScore}`:'Sin escalas'}</strong><small>{latestAssessment?.severity||'No hay evaluación registrada'}</small></article>
      </section>

      <div className="patient-unified-grid">
        <section className="patient-record-card patient-unified-main-card">
          <div className="patient-unified-card-heading"><div><span>Seguimiento terapéutico</span><h2>Qué está ocurriendo y qué sigue</h2></div><Link href={`/patients/${patient.id}/plan`}>Ver plan completo</Link></div>
          <div className="patient-followup-columns">
            <div><h3>Objetivos activos</h3>{activeGoals.slice(0,3).map(goal=><article key={goal.id} className="patient-compact-item"><div><strong>{goal.title}</strong><small>{goal.targetDate?`Objetivo: ${formatDate(goal.targetDate)}`:'Sin fecha objetivo'}</small></div><span className={`priority-dot priority-${goal.priority}`}>{goal.priority===1?'Alta':goal.priority===2?'Media':'Baja'}</span></article>)}{activeGoals.length===0&&<div className="patient-empty-compact"><p>No hay objetivos activos.</p><Link href={`/patients/${patient.id}/plan`}>Definir primer objetivo</Link></div>}</div>
            <div><h3>Tareas pendientes</h3>{pendingTasks.slice(0,3).map(task=><article key={task.id} className="patient-compact-item"><div><strong>{task.title}</strong><small>{task.dueDate?`Vence ${formatDate(task.dueDate)}`:'Sin fecha límite'}</small></div><span>{task.status==='IN_PROGRESS'?'En curso':'Pendiente'}</span></article>)}{pendingTasks.length===0&&<div className="patient-empty-compact"><p>No hay tareas pendientes.</p><Link href={`/patients/${patient.id}/tasks`}>Asignar una tarea</Link></div>}</div>
          </div>
        </section>

        <aside className="patient-record-card patient-unified-side-card"><div className="patient-unified-card-heading"><div><span>Proceso actual</span><h2>{patient.summary.activeProcess?.title||'Sin proceso activo'}</h2></div></div><dl className="patient-process-details"><div><dt>Frecuencia</dt><dd>{patient.summary.activeProcess?.frequency||'No definida'}</dd></div><div><dt>Modalidad</dt><dd>{patient.summary.activeProcess?.modality||'No definida'}</dd></div><div><dt>Sesiones</dt><dd>{patient.summary.sessionCount}</dd></div><div><dt>Última sesión</dt><dd>{formatDate(patient.summary.lastSession?.startsAt)}</dd></div></dl><Link href="/management" className="button secondary patient-card-button">Gestionar proceso</Link></aside>

        <section className="patient-record-card patient-unified-main-card"><div className="patient-unified-card-heading"><div><span>Actividad reciente</span><h2>Línea temporal clínica</h2></div><Link href={`/patients/${patient.id}/plan`}>Ver todo</Link></div><div className="patient-mini-timeline">{recentTimeline.map(item=><article key={item.id}><span>{EVENT_LABEL[item.type]||'Evento'}</span><div><strong>{item.href?<Link href={item.href}>{item.title}</Link>:item.title}</strong><small>{formatDate(item.date,true)}{item.description?` · ${item.description}`:''}</small></div></article>)}{recentTimeline.length===0&&<p>No hay actividad registrada.</p>}</div></section>

        <aside className="patient-record-card patient-unified-side-card"><div className="patient-unified-card-heading"><div><span>Accesos rápidos</span><h2>Áreas del paciente</h2></div></div><div className="patient-quick-links"><Link href={`/patients/${patient.id}/plan`}><strong>Plan y evolución</strong><span>{goals.length} objetivos · {timeline.length} eventos</span></Link><Link href={`/patients/${patient.id}/tasks`}><strong>Tareas</strong><span>{pendingTasks.length} abiertas</span></Link><Link href={`/patients/${patient.id}/assessments`}><strong>Escalas</strong><span>{assessments.length} registradas</span></Link><Link href={`/patients/${patient.id}/resources`} className="resource-link"><strong>Recursos terapéuticos</strong><span>Biblioteca y materiales compartidos</span></Link><Link href={`/messages?patientId=${patient.id}`}><strong>Mensajes</strong><span>Conversación estructurada con el paciente</span></Link><Link href={`/patients/${patient.id}/documents`}><strong>Documentos e informes</strong><span>{documents.length} documentos</span></Link><Link href={`/patients/${patient.id}/portal`}><strong>Portal del paciente</strong><span>Acceso y comunicación</span></Link></div></aside>
      </div>
    </> : <form className="patient-history-form patient-history-unified" onSubmit={saveHistory}>
      <div className="patient-history-toolbar"><div><span>Contenido profesional privado</span><h2>Historia clínica</h2><p>Esta información no se muestra al paciente.</p></div><button className="button" type="submit" disabled={saving||patient.status==='ARCHIVED'}>{saving?'Guardando…':'Guardar historia'}</button></div>
      {savedMessage&&<div className={`patient-save-state ${savedMessage.includes('sin')?'is-pending':''}`}>{savedMessage}</div>}
      <section className="patient-record-card"><div className="patient-card-heading"><div><span>01</span><div><h2>Motivo y situación actual</h2><p>Demanda inicial, problema presentado y contexto actual.</p></div></div></div><div className="patient-form-grid"><label className="patient-field patient-field-full"><span>Motivo de consulta</span><textarea value={history.reasonForConsultation??''} onChange={e=>updateField('reasonForConsultation',e.target.value)} placeholder={patient.consultationReason||'Describe el motivo principal de consulta…'}/></label><label className="patient-field patient-field-full"><span>Problema actual y evolución</span><textarea className="is-large" value={history.currentProblem??''} onChange={e=>updateField('currentProblem',e.target.value)} placeholder="Inicio, evolución, desencadenantes, impacto y estrategias utilizadas…"/></label><label className="patient-field patient-field-full"><span>Diagnóstico o hipótesis clínica</span><textarea value={history.primaryDiagnosis??''} onChange={e=>updateField('primaryDiagnosis',e.target.value)} placeholder="Diagnóstico principal, hipótesis de trabajo o formulación provisional…"/></label></div></section>
      <section className="patient-record-card"><div className="patient-card-heading"><div><span>02</span><div><h2>Antecedentes</h2><p>Información relevante para comprender el caso.</p></div></div></div><div className="patient-form-grid patient-form-grid-two"><label className="patient-field"><span>Antecedentes personales</span><textarea className="is-large" value={history.personalHistory??''} onChange={e=>updateField('personalHistory',e.target.value)}/></label><label className="patient-field"><span>Antecedentes familiares</span><textarea className="is-large" value={history.familyHistory??''} onChange={e=>updateField('familyHistory',e.target.value)}/></label><label className="patient-field"><span>Antecedentes médicos</span><textarea value={history.medicalHistory??''} onChange={e=>updateField('medicalHistory',e.target.value)}/></label><label className="patient-field"><span>Medicación actual</span><textarea value={history.currentMedication??''} onChange={e=>updateField('currentMedication',e.target.value)}/></label></div></section>
      <section className="patient-record-card"><div className="patient-card-heading"><div><span>03</span><div><h2>Evaluación clínica</h2><p>Riesgos, recursos y observaciones profesionales.</p></div></div></div><div className="patient-form-grid patient-form-grid-two"><label className="patient-field"><span>Factores de riesgo</span><textarea className="is-large" value={history.riskFactors??''} onChange={e=>updateField('riskFactors',e.target.value)}/></label><label className="patient-field"><span>Factores protectores</span><textarea className="is-large" value={history.protectiveFactors??''} onChange={e=>updateField('protectiveFactors',e.target.value)}/></label><label className="patient-field patient-field-full"><span>Observaciones clínicas</span><textarea className="is-xlarge" value={history.clinicalObservations??''} onChange={e=>updateField('clinicalObservations',e.target.value)}/></label></div></section>
      <div className="patient-form-footer"><span>Última actualización: {formatDate(history.updatedAt,true)}</span><button className="button" type="submit" disabled={saving||patient.status==='ARCHIVED'}>{saving?'Guardando…':'Guardar cambios'}</button></div>
    </form>}
  </main></div>;
}
