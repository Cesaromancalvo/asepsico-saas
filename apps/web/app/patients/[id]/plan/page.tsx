'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';

type GoalStatus = 'ACTIVE' | 'ACHIEVED' | 'PAUSED' | 'CANCELLED';
type Goal = { id:string; title:string; description?:string|null; status:GoalStatus; targetDate?:string|null; achievedAt?:string|null; priority:number; createdAt:string; updatedAt:string };
type TimelineEvent = { id:string; type:'PATIENT_CREATED'|'PROCESS'|'SESSION'|'HISTORY'|'GOAL'|'TASK'|'ASSESSMENT'|'DOCUMENT'|'CONSENT'|'REPORT'; date:string; title:string; description?:string|null; status?:string|null; href?:string|null };
type Patient = { id:string; firstName:string; lastName:string; status:string; summary:{ activeProcess?:{title:string}|null } };

const STATUS_LABEL: Record<GoalStatus,string> = { ACTIVE:'Activo', ACHIEVED:'Alcanzado', PAUSED:'Pausado', CANCELLED:'Cancelado' };
const TYPE_ICON: Record<TimelineEvent['type'],string> = { PATIENT_CREATED:'P', PROCESS:'PR', SESSION:'S', HISTORY:'HC', GOAL:'O', TASK:'T', ASSESSMENT:'E', DOCUMENT:'D', CONSENT:'C', REPORT:'I' };

function formatDate(value?: string | null, includeTime=false) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-ES',{ day:'2-digit', month:'short', year:'numeric', ...(includeTime?{hour:'2-digit',minute:'2-digit'}:{}) }).format(new Date(value));
}

export default function PatientPlanPage(){
  const { id: patientId } = useParams<{id:string}>();
  const [patient,setPatient]=useState<Patient|null>(null);
  const [goals,setGoals]=useState<Goal[]>([]);
  const [timeline,setTimeline]=useState<TimelineEvent[]>([]);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [filter,setFilter]=useState<'ALL'|TimelineEvent['type']>('ALL');

  async function load(){
    try{
      setLoading(true); setError('');
      const [patientData,goalData,timelineData]=await Promise.all([
        api<Patient>(`/patients/${patientId}`),
        api<Goal[]>(`/patients/${patientId}/goals`),
        api<TimelineEvent[]>(`/patients/${patientId}/timeline`),
      ]);
      setPatient(patientData); setGoals(goalData); setTimeline(timelineData);
    }catch(err){ setError(err instanceof Error?err.message:'No se pudo cargar el plan terapéutico'); }
    finally{ setLoading(false); }
  }
  useEffect(()=>{ load(); },[patientId]);

  async function createGoal(event:FormEvent<HTMLFormElement>){
    event.preventDefault(); const form=event.currentTarget; const data=new FormData(form);
    try{
      setSaving(true); setError('');
      await api(`/patients/${patientId}/goals`,{method:'POST',body:JSON.stringify({
        title:data.get('title'), description:data.get('description')||undefined,
        targetDate:data.get('targetDate')||undefined, priority:Number(data.get('priority')||2),
      })});
      form.reset(); await load();
    }catch(err){ setError(err instanceof Error?err.message:'No se pudo crear el objetivo'); }
    finally{ setSaving(false); }
  }

  async function setGoalStatus(goal:Goal,status:GoalStatus){
    try{ setError(''); await api(`/patients/${patientId}/goals/${goal.id}`,{method:'PATCH',body:JSON.stringify({status})}); await load(); }
    catch(err){ setError(err instanceof Error?err.message:'No se pudo actualizar el objetivo'); }
  }
  async function removeGoal(goal:Goal){
    if(!window.confirm(`¿Eliminar el objetivo “${goal.title}”?`)) return;
    try{ await api(`/patients/${patientId}/goals/${goal.id}`,{method:'DELETE'}); await load(); }
    catch(err){ setError(err instanceof Error?err.message:'No se pudo eliminar el objetivo'); }
  }

  const activeGoals=goals.filter(g=>g.status==='ACTIVE');
  const achievedGoals=goals.filter(g=>g.status==='ACHIEVED');
  const progress=goals.length?Math.round((achievedGoals.length/goals.length)*100):0;
  const filteredTimeline=useMemo(()=>filter==='ALL'?timeline:timeline.filter(item=>item.type===filter),[timeline,filter]);

  if(loading) return <div className="app-layout"><Sidebar/><main className="patient-plan-page"><div className="patient-record-loading">Cargando plan terapéutico…</div></main></div>;
  if(!patient) return <div className="app-layout"><Sidebar/><main className="patient-plan-page"><div className="agenda-error">{error||'Paciente no encontrado'}</div></main></div>;

  return <div className="app-layout"><Sidebar syncText="Plan terapéutico actualizado"/><main className="patient-plan-page">
    <header className="patient-plan-header">
      <div><Link href={`/patients/${patient.id}`} className="patient-record-back">← Volver a la historia clínica</Link><div className="patient-record-kicker">Seguimiento clínico</div><h1>Plan terapéutico de {patient.firstName} {patient.lastName}</h1><p>{patient.summary.activeProcess?.title||'Sin proceso terapéutico activo'}</p></div>
      <div className="patient-record-actions"><Link href={`/patients/${patient.id}/tasks`} className="button secondary">Tareas</Link><Link href={`/agenda?patientId=${patient.id}`} className="button">Programar sesión</Link></div>
    </header>
    {error&&<div className="agenda-error">{error}</div>}

    <section className="therapy-overview-grid">
      <article><span>Objetivos activos</span><strong>{activeGoals.length}</strong><small>En curso</small></article>
      <article><span>Objetivos alcanzados</span><strong>{achievedGoals.length}</strong><small>Logros registrados</small></article>
      <article><span>Progreso global</span><strong>{progress}%</strong><div className="therapy-progress"><i style={{width:`${progress}%`}}/></div></article>
      <article><span>Eventos clínicos</span><strong>{timeline.length}</strong><small>En la línea temporal</small></article>
    </section>

    <div className="patient-plan-layout">
      <section className="patient-plan-column">
        <article className="patient-record-card">
          <div className="patient-plan-section-heading"><div><span>01</span><div><h2>Objetivos terapéuticos</h2><p>Define, prioriza y revisa los resultados esperados del proceso.</p></div></div></div>
          <form className="therapy-goal-form" onSubmit={createGoal}>
            <label><span>Nuevo objetivo</span><input name="title" required minLength={2} maxLength={180} placeholder="Ej. Reducir la evitación en situaciones sociales"/></label>
            <label><span>Descripción</span><textarea name="description" placeholder="Criterios de logro, indicadores y contexto…"/></label>
            <div className="therapy-goal-form-row"><label><span>Fecha objetivo</span><input name="targetDate" type="date"/></label><label><span>Prioridad</span><select name="priority" defaultValue="2"><option value="1">Alta</option><option value="2">Media</option><option value="3">Baja</option></select></label><button className="button" disabled={saving}>{saving?'Añadiendo…':'Añadir objetivo'}</button></div>
          </form>
          <div className="therapy-goals-list">
            {goals.map(goal=><article key={goal.id} className={`therapy-goal-card goal-${goal.status.toLowerCase()}`}>
              <div className="therapy-goal-main"><div className="therapy-goal-top"><span className={`goal-priority priority-${goal.priority}`}>{goal.priority===1?'Alta':goal.priority===2?'Media':'Baja'}</span><span className={`goal-status status-${goal.status.toLowerCase()}`}>{STATUS_LABEL[goal.status]}</span></div><h3>{goal.title}</h3>{goal.description&&<p>{goal.description}</p>}<small>Fecha objetivo: {formatDate(goal.targetDate)}</small></div>
              <div className="therapy-goal-actions">{goal.status!=='ACHIEVED'&&<button onClick={()=>setGoalStatus(goal,'ACHIEVED')}>Marcar logrado</button>}{goal.status==='ACHIEVED'&&<button onClick={()=>setGoalStatus(goal,'ACTIVE')}>Reabrir</button>}{goal.status==='ACTIVE'&&<button onClick={()=>setGoalStatus(goal,'PAUSED')}>Pausar</button>}{goal.status==='PAUSED'&&<button onClick={()=>setGoalStatus(goal,'ACTIVE')}>Reactivar</button>}<button className="danger" onClick={()=>removeGoal(goal)}>Eliminar</button></div>
            </article>)}
            {goals.length===0&&<div className="therapy-empty"><strong>Aún no hay objetivos definidos</strong><p>Añade el primer objetivo para comenzar el seguimiento del plan terapéutico.</p></div>}
          </div>
        </article>
      </section>

      <aside className="patient-plan-column">
        <article className="patient-record-card">
          <div className="patient-plan-section-heading"><div><span>02</span><div><h2>Línea temporal</h2><p>Actividad clínica ordenada cronológicamente.</p></div></div></div>
          <div className="timeline-filters"><button className={filter==='ALL'?'active':''} onClick={()=>setFilter('ALL')}>Todo</button><button className={filter==='SESSION'?'active':''} onClick={()=>setFilter('SESSION')}>Sesiones</button><button className={filter==='GOAL'?'active':''} onClick={()=>setFilter('GOAL')}>Objetivos</button><button className={filter==='HISTORY'?'active':''} onClick={()=>setFilter('HISTORY')}>Historia</button><button className={filter==='TASK'?'active':''} onClick={()=>setFilter('TASK')}>Tareas</button><button className={filter==='ASSESSMENT'?'active':''} onClick={()=>setFilter('ASSESSMENT')}>Escalas</button><button className={filter==='DOCUMENT'?'active':''} onClick={()=>setFilter('DOCUMENT')}>Documentos</button></div>
          <div className="clinical-timeline">{filteredTimeline.map(item=><div className="timeline-item" key={item.id}><div className={`timeline-icon timeline-${item.type.toLowerCase()}`}>{TYPE_ICON[item.type]}</div><div><time>{formatDate(item.date,true)}</time><h3>{item.href?<Link href={item.href}>{item.title}</Link>:item.title}</h3>{item.description&&<p>{item.description}</p>}{item.status&&<span>{item.status.replaceAll('_',' ')}</span>}</div></div>)}{filteredTimeline.length===0&&<div className="therapy-empty"><p>No hay eventos para este filtro.</p></div>}</div>
        </article>
      </aside>
    </div>
  </main></div>;
}
