'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import ClinicalSubpageGate from '@/components/ClinicalSubpageGate';
import { api } from '@/lib/api';
import TaskActions from '@/components/TaskActions';

type TaskStatus='DRAFT'|'PENDING'|'IN_PROGRESS'|'SUBMITTED'|'CHANGES_REQUESTED'|'COMPLETED'|'CANCELLED';
type Goal={id:string;title:string;status:string};
type Template={id:string;title:string;instructions?:string|null;category?:string|null};
type Task={id:string;title:string;instructions?:string|null;status:TaskStatus;dueDate?:string|null;patientFeedback?:string|null;clinicianNotes?:string|null;reviewComment?:string|null;submittedAt?:string|null;completedAt?:string|null;therapyGoal?:Goal|null;createdAt:string;updatedAt:string};
type Patient={id:string;firstName:string;lastName:string;status:string};
const LABEL:Record<TaskStatus,string>={DRAFT:'Borrador',PENDING:'Asignada',IN_PROGRESS:'En curso',SUBMITTED:'Entregada',CHANGES_REQUESTED:'Cambios solicitados',COMPLETED:'Completada',CANCELLED:'Cancelada'};
const fmt=(v?:string|null)=>v?new Intl.DateTimeFormat('es-ES',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(v)):'Sin fecha';

/**
 * Solo con TREATING: con acceso excepcional (o sin relación) no se montan las notas internas ni
 * los controles de escritura; se remite a la ficha en solo lectura (revisión de Argos).
 */
export default function PatientTasksPage(){
  const {id:patientId}=useParams<{id:string}>();
  return <ClinicalSubpageGate patientId={patientId} section="Tareas"><PatientTasksPageContent/></ClinicalSubpageGate>;
}

/** Aviso tras cada acción sobre una tarea (se lee en voz alta con role="status"). */
const ACTION_NOTICE:Partial<Record<TaskStatus,string>>={PENDING:'Tarea asignada.',COMPLETED:'Tarea completada con tu devolución.',CHANGES_REQUESTED:'Cambios solicitados al paciente.',CANCELLED:'Tarea cancelada.',IN_PROGRESS:'Tarea reabierta.'};

function PatientTasksPageContent(){
 const {id:patientId}=useParams<{id:string}>();
 const [patient,setPatient]=useState<Patient|null>(null),[tasks,setTasks]=useState<Task[]>([]),[goals,setGoals]=useState<Goal[]>([]),[templates,setTemplates]=useState<Template[]>([]);
 const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(''),[filter,setFilter]=useState<'ALL'|TaskStatus>('ALL');
 const [selectedTemplate,setSelectedTemplate]=useState('');
 // Acciones sobre la lista: tarea en curso de guardar, aviso y error junto a la propia lista.
 const [busyTask,setBusyTask]=useState<string|null>(null),[notice,setNotice]=useState(''),[listError,setListError]=useState('');
 useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(''),6000);return()=>clearTimeout(t)},[notice]);
 /** Carga inicial con pantalla de carga; los refrescos posteriores son silenciosos (no vacían la lista ni mueven el scroll). */
 async function load(){try{setLoading(true);setError('');const [p,t,g,tm]=await Promise.all([api<Patient>(`/patients/${patientId}`),api<Task[]>(`/patients/${patientId}/tasks`),api<Goal[]>(`/patients/${patientId}/goals`),api<Template[]>('/patients/task-templates/library')]);setPatient(p);setTasks(t);setGoals(g);setTemplates(tm);}catch(e){setError(e instanceof Error?e.message:'No se pudieron cargar las tareas');}finally{setLoading(false)}}
 async function refreshTasks(){try{setTasks(await api<Task[]>(`/patients/${patientId}/tasks`))}catch(e){setListError(e instanceof Error?e.message:'No se pudo actualizar la lista de tareas')}}
 async function refreshTemplates(){try{setTemplates(await api<Template[]>('/patients/task-templates/library'))}catch{/* la lista anterior sigue siendo válida */}}
 useEffect(()=>{load()},[patientId]);
 async function createTask(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=e.currentTarget,fd=new FormData(form);const draft=fd.get('action')==='draft';try{setSaving(true);setError('');await api(`/patients/${patientId}/tasks`,{method:'POST',body:JSON.stringify({title:fd.get('title'),instructions:fd.get('instructions')||undefined,dueDate:fd.get('dueDate')||undefined,therapyGoalId:fd.get('therapyGoalId')||undefined,saveAsDraft:draft})});form.reset();setSelectedTemplate('');setListError('');setNotice(draft?'Borrador guardado.':'Tarea asignada.');await refreshTasks()}catch(err){setError(err instanceof Error?err.message:'No se pudo crear la tarea')}finally{setSaving(false)}}
 /** Actualización optimista: la tarjeta cambia al momento; si la API falla se avisa y se vuelve al estado real. */
 async function update(task:Task,payload:Partial<Pick<Task,'status'|'reviewComment'|'clinicianNotes'>>,message?:string){
  setBusyTask(task.id);setListError('');setNotice('');
  setTasks(list=>list.map(t=>t.id===task.id?{...t,...payload}:t));
  try{await api(`/patients/${patientId}/tasks/${task.id}`,{method:'PATCH',body:JSON.stringify(payload)});setNotice(message??(payload.status?ACTION_NOTICE[payload.status]??'Tarea actualizada.':'Cambios guardados.'))}
  catch(err){setListError(err instanceof Error?err.message:'No se pudo actualizar la tarea')}
  finally{await refreshTasks();setBusyTask(null)}
 }
 async function removeDraft(task:Task){if(!confirm(`¿Eliminar el borrador “${task.title}”?`))return;setBusyTask(task.id);setListError('');setNotice('');try{await api(`/patients/${patientId}/tasks/${task.id}`,{method:'DELETE'});setTasks(list=>list.filter(t=>t.id!==task.id));setNotice('Borrador eliminado.')}catch(err){setListError(err instanceof Error?err.message:'No se pudo eliminar')}finally{setBusyTask(null)}}
 function cancelTask(task:Task){if(confirm(`¿Cancelar la tarea “${task.title}”? Dejará de aparecer en el portal del paciente.`))update(task,{status:'CANCELLED'})}
 const reviewValue=(task:Task)=>(document.getElementById(`review-${task.id}`) as HTMLTextAreaElement|null)?.value||'';
 async function saveTemplate(e:FormEvent<HTMLFormElement>){e.preventDefault();const f=e.currentTarget,fd=new FormData(f);try{setError('');await api('/patients/task-templates/library',{method:'POST',body:JSON.stringify({title:fd.get('title'),instructions:fd.get('instructions'),category:fd.get('category')})});f.reset();await refreshTemplates()}catch(err){setError(err instanceof Error?err.message:'No se pudo guardar la plantilla')}}
 const visible=useMemo(()=>filter==='ALL'?tasks:tasks.filter(t=>t.status===filter),[tasks,filter]);
 const pending=tasks.filter(t=>['PENDING','IN_PROGRESS','CHANGES_REQUESTED'].includes(t.status)).length,submitted=tasks.filter(t=>t.status==='SUBMITTED').length,completed=tasks.filter(t=>t.status==='COMPLETED').length;
 const selected=templates.find(t=>t.id===selectedTemplate);
 if(loading)return <div className="app-layout"><Sidebar/><main className="patient-tasks-page"><div className="patient-record-loading">Cargando flujo de tareas…</div></main></div>;
 if(!patient)return <div className="app-layout"><Sidebar/><main className="patient-tasks-page"><div className="agenda-error">{error||'Paciente no encontrado'}</div></main></div>;
 return <div className="app-layout"><Sidebar syncText="Trabajo entre sesiones"/><main className="patient-tasks-page">
  <header className="patient-plan-header"><div><Link href={`/patients/${patient.id}`} className="patient-record-back">← Volver a la ficha clínica</Link><div className="patient-record-kicker">Ficha · Tareas terapéuticas</div><h1>Tareas de {patient.firstName} {patient.lastName}</h1><p>Asigna, recibe, revisa y cierra el trabajo terapéutico entre sesiones.</p></div></header>
  {error&&<div className="agenda-error">{error}</div>}
  <section className="therapy-overview-grid"><article><span>En trabajo</span><strong>{pending}</strong><small>Asignadas o en curso</small></article><article><span>Por revisar</span><strong>{submitted}</strong><small>Entregadas por el paciente</small></article><article><span>Completadas</span><strong>{completed}</strong><small>Revisadas por el profesional</small></article><article><span>Total</span><strong>{tasks.length}</strong><small>Incluye borradores y canceladas</small></article></section>
  <div className="patient-tasks-layout"><section className="patient-record-card"><div className="patient-plan-section-heading"><div><span>01</span><div><h2>Nueva tarea</h2><p>Usa una plantilla o redacta una indicación personalizada.</p></div></div></div>
   <form className="therapy-goal-form" onSubmit={createTask}><label><span>Plantilla</span><select value={selectedTemplate} onChange={e=>setSelectedTemplate(e.target.value)}><option value="">Tarea personalizada</option>{templates.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label><label><span>Título</span><input name="title" required minLength={2} maxLength={180} key={`title-${selectedTemplate}`} defaultValue={selected?.title||''}/></label><label><span>Instrucciones</span><textarea name="instructions" maxLength={5000} key={`instructions-${selectedTemplate}`} defaultValue={selected?.instructions||''}/></label><div className="task-form-row"><label><span>Fecha orientativa</span><input type="date" name="dueDate"/></label><label><span>Objetivo asociado</span><select name="therapyGoalId" defaultValue=""><option value="">Sin objetivo asociado</option>{goals.map(g=><option key={g.id} value={g.id}>{g.title}</option>)}</select></label></div><div className="patient-record-actions task-form-actions"><button className="button secondary" name="action" value="draft" disabled={saving}>Guardar borrador</button><button className="button" name="action" value="assign" disabled={saving||patient.status==='ARCHIVED'}>{saving?'Guardando…':'Asignar al paciente'}</button></div></form>
  </section>
  <section className="patient-record-card"><div className="task-list-heading"><div><h2>Seguimiento</h2><p>El paciente entrega; el profesional valida el cierre.</p></div><div className="timeline-filters"><button className={filter==='ALL'?'active':''} onClick={()=>setFilter('ALL')}>Todas</button><button className={filter==='SUBMITTED'?'active':''} onClick={()=>setFilter('SUBMITTED')}>Por revisar</button><button className={filter==='IN_PROGRESS'?'active':''} onClick={()=>setFilter('IN_PROGRESS')}>En curso</button><button className={filter==='COMPLETED'?'active':''} onClick={()=>setFilter('COMPLETED')}>Completadas</button></div></div>
   <div className="task-list-feedback" aria-live="polite">{notice&&<div className="patient-save-state" role="status">{notice}</div>}</div>
   {listError&&<div className="agenda-error" role="alert">{listError}</div>}
   <div className="therapeutic-task-list">{visible.map(task=>{const busy=busyTask===task.id;return <article key={task.id} className={`therapeutic-task-card task-${task.status.toLowerCase()}`} aria-busy={busy}><div className="task-card-main"><div className="therapy-goal-top"><span className={`task-status task-status-${task.status.toLowerCase()}`}>{LABEL[task.status]}</span>{task.dueDate&&<span className="task-date">Fecha objetivo {fmt(task.dueDate)}</span>}{task.therapyGoal&&<span className="task-goal">{task.therapyGoal.title}</span>}</div><h3>{task.title}</h3>{task.instructions&&<p>{task.instructions}</p>}
   {task.patientFeedback&&<div className="patient-record-card"><strong>Respuesta del paciente</strong><p>{task.patientFeedback}</p>{task.submittedAt&&<small>Entregada {fmt(task.submittedAt)}</small>}</div>}
   {task.reviewComment&&task.status!=='SUBMITTED'&&<div className="patient-record-card"><strong>Devolución profesional</strong><p>{task.reviewComment}</p></div>}
   <div className="task-notes-grid">{task.status==='SUBMITTED'&&<label className="task-review-field"><span>Devolución para el paciente</span><textarea id={`review-${task.id}`} defaultValue={task.reviewComment||''} placeholder="Feedback breve, claro y no punitivo…"/></label>}
   <label><span>Nota clínica privada</span><textarea defaultValue={task.clinicianNotes||''} placeholder="Solo para ti; el paciente no la ve." onBlur={e=>{if(e.target.value!==(task.clinicianNotes||''))update(task,{clinicianNotes:e.target.value},'Nota privada guardada.')}}/></label></div></div>
   <TaskActions task={task} busy={busy} onAssign={()=>update(task,{status:'PENDING'})} onRemoveDraft={()=>removeDraft(task)} onComplete={()=>update(task,{status:'COMPLETED',reviewComment:reviewValue(task)})} onRequestChanges={()=>update(task,{status:'CHANGES_REQUESTED',reviewComment:reviewValue(task)})} onReopen={()=>update(task,{status:'IN_PROGRESS'})} onCancel={()=>cancelTask(task)}/></article>})}{visible.length===0&&<div className="therapy-empty"><strong>No hay tareas en esta vista</strong><p>Crea una tarea o cambia el filtro.</p></div>}</div>
  </section></div>
  <section className="patient-record-card"><div className="patient-plan-section-heading"><div><span>02</span><div><h2>Biblioteca de plantillas</h2><p>Guarda indicaciones reutilizables sin vincularlas a ningún paciente.</p></div></div></div><form className="therapy-goal-form" onSubmit={saveTemplate}><label><span>Nombre</span><input name="title" required minLength={2} maxLength={180}/></label><label><span>Instrucciones base</span><textarea name="instructions" maxLength={5000}/></label><div className="task-form-row"><label><span>Categoría</span><input name="category" maxLength={80} placeholder="Registro, exposición, psicoeducación…"/></label><button className="button secondary">Guardar plantilla</button></div></form></section>
 </main></div>
}
