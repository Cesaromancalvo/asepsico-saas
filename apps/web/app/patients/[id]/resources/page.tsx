'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';

type Category='PSYCHOEDUCATION'|'EXERCISE'|'WORKSHEET'|'AUDIO'|'VIDEO'|'READING'|'OTHER';
type Resource={id:string;title:string;description?:string|null;type:'LINK'|'FILE';category:Category;url?:string|null;fileName?:string|null;mimeType?:string|null;_count?:{shares:number}};
type Share={id:string;sharedAt:string;resource:Resource};
type Patient={id:string;firstName:string;lastName:string;status:string};
const CATEGORY:Record<Category,string>={PSYCHOEDUCATION:'Psicoeducación',EXERCISE:'Ejercicio',WORKSHEET:'Hoja de trabajo',AUDIO:'Audio',VIDEO:'Vídeo',READING:'Lectura',OTHER:'Otro'};

export default function PatientResourcesPage(){
  const {id:patientId}=useParams<{id:string}>();
  const [patient,setPatient]=useState<Patient|null>(null); const [library,setLibrary]=useState<Resource[]>([]); const [shares,setShares]=useState<Share[]>([]);
  const [loading,setLoading]=useState(true); const [saving,setSaving]=useState(false); const [error,setError]=useState(''); const [query,setQuery]=useState('');
  async function load(){try{setLoading(true);setError('');const [p,l,s]=await Promise.all([api<Patient>(`/patients/${patientId}`),api<Resource[]>('/resources'),api<Share[]>(`/patients/${patientId}/resources`)]);setPatient(p);setLibrary(l);setShares(s);}catch(e){setError(e instanceof Error?e.message:'No se pudieron cargar los recursos');}finally{setLoading(false);}}
  useEffect(()=>{load();},[patientId]);
  const sharedIds=useMemo(()=>new Set(shares.map(s=>s.resource.id)),[shares]);
  const visible=useMemo(()=>library.filter(r=>r.title.toLowerCase().includes(query.toLowerCase())||CATEGORY[r.category].toLowerCase().includes(query.toLowerCase())),[library,query]);
  async function create(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=e.currentTarget;const data=new FormData(form);const type=data.get('type') as 'LINK'|'FILE';try{setSaving(true);await api('/resources',{method:'POST',body:JSON.stringify({title:data.get('title'),description:data.get('description')||undefined,type,category:data.get('category'),url:type==='LINK'?data.get('url'):undefined,fileName:type==='FILE'?data.get('fileName'):undefined,mimeType:type==='FILE'?'application/octet-stream':undefined,storageKey:type==='FILE'?`pending/${Date.now()}-${data.get('fileName')}`:undefined})});form.reset();await load();}catch(e){setError(e instanceof Error?e.message:'No se pudo crear el recurso');}finally{setSaving(false);}}
  async function share(resourceId:string){try{await api(`/patients/${patientId}/resources/${resourceId}/share`,{method:'POST'});await load();}catch(e){setError(e instanceof Error?e.message:'No se pudo compartir el recurso');}}
  async function revoke(resourceId:string){if(!window.confirm('¿Retirar este recurso del portal del paciente?'))return;try{await api(`/patients/${patientId}/resources/${resourceId}/share`,{method:'DELETE'});await load();}catch(e){setError(e instanceof Error?e.message:'No se pudo retirar el recurso');}}
  async function archive(resource:Resource){if(!window.confirm(`¿Archivar “${resource.title}”? Se retirará de todos los pacientes.`))return;try{await api(`/resources/${resource.id}`,{method:'DELETE'});await load();}catch(e){setError(e instanceof Error?e.message:'No se pudo archivar el recurso');}}
  if(loading)return <div className="app-layout"><Sidebar/><main className="resource-page"><div className="patient-record-loading">Cargando recursos terapéuticos…</div></main></div>;
  if(!patient)return <div className="app-layout"><Sidebar/><main className="resource-page"><div className="agenda-error">{error||'Paciente no encontrado'}</div></main></div>;
  return <div className="app-layout"><Sidebar syncText="Material terapéutico compartido"/><main className="resource-page">
    <header className="patient-plan-header"><div><Link href={`/patients/${patient.id}`} className="patient-record-back">← Volver a la ficha clínica</Link><div className="patient-record-kicker">Sprint 10 · Continuidad</div><h1>Recursos de {patient.firstName} {patient.lastName}</h1><p>Crea una biblioteca reutilizable y controla exactamente qué material puede ver este paciente.</p></div><div className="patient-record-actions"><Link href={`/patients/${patient.id}/tasks`} className="button secondary">Ver tareas</Link><Link href={`/patients/${patient.id}/portal`} className="button">Portal del paciente</Link></div></header>
    {error&&<div className="agenda-error">{error}</div>}
    <section className="resource-summary-grid"><article><span>Biblioteca</span><strong>{library.length}</strong><small>Recursos disponibles</small></article><article><span>Compartidos</span><strong>{shares.length}</strong><small>Visibles para el paciente</small></article><article><span>Enlaces</span><strong>{library.filter(r=>r.type==='LINK').length}</strong><small>Acceso inmediato</small></article></section>
    <div className="resource-layout">
      <section className="patient-record-card"><div className="patient-plan-section-heading"><div><span>01</span><div><h2>Nuevo recurso</h2><p>Guarda una vez y reutiliza con distintos pacientes.</p></div></div></div>
        <form className="resource-form" onSubmit={create}><label><span>Título</span><input name="title" required minLength={2} maxLength={180} placeholder="Ej. Guía breve de respiración diafragmática"/></label><label><span>Descripción para el paciente</span><textarea name="description" maxLength={2000} placeholder="Qué contiene y cómo utilizarlo…"/></label><div className="resource-form-row"><label><span>Formato</span><select name="type"><option value="LINK">Enlace</option><option value="FILE">Archivo (metadatos)</option></select></label><label><span>Categoría</span><select name="category" defaultValue="PSYCHOEDUCATION">{Object.entries(CATEGORY).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label></div><label><span>URL del recurso</span><input name="url" type="url" placeholder="https://…"/></label><label><span>Nombre del archivo</span><input name="fileName" placeholder="material-respiracion.pdf"/></label><button className="button" disabled={saving||patient.status==='ARCHIVED'}>{saving?'Guardando…':'Guardar en biblioteca'}</button><small className="resource-help">En esta versión los archivos se registran de forma segura por metadatos. La carga binaria privada se conectará al almacenamiento de MinIO antes del piloto.</small></form>
      </section>
      <section className="patient-record-card"><div className="resource-list-heading"><div><span>02</span><div><h2>Biblioteca terapéutica</h2><p>Comparte o retira materiales sin duplicarlos.</p></div></div><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar recurso…"/></div>
        <div className="resource-list">{visible.map(resource=><article key={resource.id} className="resource-card"><div className="resource-card-top"><span>{CATEGORY[resource.category]}</span><small>{resource.type==='LINK'?'Enlace':'Archivo'}</small></div><h3>{resource.title}</h3>{resource.description&&<p>{resource.description}</p>}<div className="resource-card-actions">{sharedIds.has(resource.id)?<button className="secondary" onClick={()=>revoke(resource.id)}>Retirar del paciente</button>:<button onClick={()=>share(resource.id)}>Compartir con paciente</button>}{resource.url&&<a href={resource.url} target="_blank" rel="noreferrer">Abrir</a>}<button className="danger" onClick={()=>archive(resource)}>Archivar</button></div></article>)}{visible.length===0&&<div className="therapy-empty"><strong>No hay recursos</strong><p>Crea el primer material o cambia la búsqueda.</p></div>}</div>
      </section>
    </div>
    <section className="patient-record-card resource-shared-section"><div className="patient-unified-card-heading"><div><span>Visibilidad del paciente</span><h2>Recursos compartidos actualmente</h2></div></div><div className="resource-shared-grid">{shares.map(share=><article key={share.id}><span>{CATEGORY[share.resource.category]}</span><strong>{share.resource.title}</strong><small>Compartido {new Intl.DateTimeFormat('es-ES',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(share.sharedAt))}</small><button onClick={()=>revoke(share.resource.id)}>Retirar acceso</button></article>)}{shares.length===0&&<p>El paciente todavía no tiene recursos compartidos.</p>}</div></section>
  </main></div>;
}
