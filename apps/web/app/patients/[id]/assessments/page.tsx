'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';

type ScaleCode = 'PHQ9' | 'GAD7' | 'WHO5';
type Patient = { id:string; firstName:string; lastName:string; status:string };
type Assessment = { id:string; scaleCode:ScaleCode; scaleName:string; answers:number[]; totalScore:number; severity:string; interpretation:string; riskFlag:boolean; clinicalNotes?:string|null; administeredAt:string; createdAt:string };

type Scale = { code:ScaleCode; name:string; domain:string; questionCount:number; answerMin:number; answerMax:number };

const QUESTIONS: Record<ScaleCode,string[]> = {
  PHQ9: ['Poco interés o placer en hacer cosas','Sentirse decaído/a, deprimido/a o sin esperanza','Dificultad para dormir o dormir demasiado','Cansancio o poca energía','Poco apetito o comer en exceso','Sentirse mal consigo mismo/a','Dificultad para concentrarse','Moverse o hablar muy despacio, o estar muy inquieto/a','Pensamientos de que estaría mejor muerto/a o de hacerse daño'],
  GAD7: ['Sentirse nervioso/a, ansioso/a o al límite','No poder parar o controlar la preocupación','Preocuparse demasiado por diferentes cosas','Dificultad para relajarse','Estar tan inquieto/a que cuesta permanecer sentado/a','Irritarse o molestarse con facilidad','Sentir miedo como si algo terrible pudiera ocurrir'],
  WHO5: ['Me he sentido alegre y de buen ánimo','Me he sentido tranquilo/a y relajado/a','Me he sentido activo/a y con energía','Me he despertado fresco/a y descansado/a','Mi vida cotidiana ha estado llena de cosas interesantes'],
};

const OPTIONS: Record<ScaleCode,string[]> = {
  PHQ9: ['Nunca','Varios días','Más de la mitad de los días','Casi todos los días'],
  GAD7: ['Nunca','Varios días','Más de la mitad de los días','Casi todos los días'],
  WHO5: ['En ningún momento','Alguna vez','Menos de la mitad del tiempo','Más de la mitad del tiempo','La mayor parte del tiempo','Todo el tiempo'],
};

function fmt(value:string){return new Intl.DateTimeFormat('es-ES',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(value));}

export default function AssessmentsPage(){
  const {id:patientId}=useParams<{id:string}>();
  const [patient,setPatient]=useState<Patient|null>(null);
  const [items,setItems]=useState<Assessment[]>([]);
  const [catalog,setCatalog]=useState<Scale[]>([]);
  const [scaleCode,setScaleCode]=useState<ScaleCode>('PHQ9');
  const [answers,setAnswers]=useState<number[]>(Array(9).fill(0));
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');

  async function load(){
    try{
      setLoading(true);setError('');
      const [p,a,c]=await Promise.all([
        api<Patient>(`/patients/${patientId}`),
        api<Assessment[]>(`/patients/${patientId}/assessments`),
        api<Scale[]>(`/patients/${patientId}/assessments/catalog`),
      ]);
      setPatient(p);setItems(a);setCatalog(c);
    }catch(e){setError(e instanceof Error?e.message:'No se pudieron cargar las escalas');}
    finally{setLoading(false);}
  }
  useEffect(()=>{load();},[patientId]);
  useEffect(()=>{setAnswers(Array(QUESTIONS[scaleCode].length).fill(0));},[scaleCode]);

  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    const form=e.currentTarget;
    const data=new FormData(form);
    try{
      setSaving(true);setError('');
      await api(`/patients/${patientId}/assessments`,{method:'POST',body:JSON.stringify({scaleCode,answers,administeredAt:data.get('administeredAt')||undefined,clinicalNotes:data.get('clinicalNotes')||undefined})});
      form.reset();setAnswers(Array(QUESTIONS[scaleCode].length).fill(0));await load();
    }catch(err){setError(err instanceof Error?err.message:'No se pudo guardar la evaluación');}
    finally{setSaving(false);}
  }
  async function remove(item:Assessment){
    if(!window.confirm(`¿Eliminar la evaluación ${item.scaleName} del ${fmt(item.administeredAt)}?`))return;
    try{await api(`/patients/${patientId}/assessments/${item.id}`,{method:'DELETE'});await load();}
    catch(err){setError(err instanceof Error?err.message:'No se pudo eliminar la evaluación');}
  }

  const latest=useMemo(()=>catalog.map(scale=>({scale,last:items.find(i=>i.scaleCode===scale.code)})),[catalog,items]);
  if(loading)return <div className="app-layout"><Sidebar/><main className="assessment-page"><div className="patient-record-loading">Cargando escalas clínicas…</div></main></div>;
  if(!patient)return <div className="app-layout"><Sidebar/><main className="assessment-page"><div className="agenda-error">{error||'Paciente no encontrado'}</div></main></div>;

  return <div className="app-layout"><Sidebar syncText="Seguimiento clínico"/><main className="assessment-page">
    <header className="patient-plan-header"><div><Link href={`/patients/${patient.id}`} className="patient-record-back">← Volver a la ficha clínica</Link><div className="patient-record-kicker">Sprint 4 · Evaluación</div><h1>Escalas clínicas de {patient.firstName} {patient.lastName}</h1><p>Aplicación estructurada, puntuación automática y evolución longitudinal.</p></div><div className="patient-record-actions"><Link href={`/patients/${patient.id}/plan`} className="button secondary">Plan terapéutico</Link><Link href={`/patients/${patient.id}/tasks`} className="button secondary">Tareas</Link></div></header>
    {error&&<div className="agenda-error">{error}</div>}

    <section className="assessment-summary-grid">{latest.map(({scale,last})=><article key={scale.code}><span>{scale.domain}</span><strong>{last?last.totalScore:'—'}</strong><h3>{scale.name}</h3><small>{last?`${last.severity} · ${fmt(last.administeredAt)}`:'Sin aplicaciones'}</small></article>)}</section>

    <div className="assessment-layout">
      <section className="patient-record-card"><div className="patient-plan-section-heading"><div><span>01</span><div><h2>Nueva aplicación</h2><p>Selecciona una escala y registra las respuestas del paciente.</p></div></div></div>
        <form onSubmit={submit} className="assessment-form">
          <div className="assessment-form-top"><label><span>Escala</span><select value={scaleCode} onChange={e=>setScaleCode(e.target.value as ScaleCode)}>{catalog.map(s=><option key={s.code} value={s.code}>{s.name} · {s.domain}</option>)}</select></label><label><span>Fecha de aplicación</span><input type="date" name="administeredAt"/></label></div>
          <div className="assessment-questions">{QUESTIONS[scaleCode].map((q,index)=><fieldset key={q}><legend><b>{index+1}</b>{q}</legend><div>{OPTIONS[scaleCode].map((option,value)=><label key={option} className={answers[index]===value?'selected':''}><input type="radio" name={`q-${index}`} checked={answers[index]===value} onChange={()=>setAnswers(current=>current.map((v,i)=>i===index?value:v))}/><span>{value}</span><small>{option}</small></label>)}</div></fieldset>)}</div>
          <label><span>Notas clínicas</span><textarea name="clinicalNotes" maxLength={2000} placeholder="Contexto de aplicación, observaciones relevantes o decisiones clínicas…"/></label>
          <div className="assessment-submit"><span>Puntuación provisional: <strong>{answers.reduce((a,b)=>a+b,0)}</strong></span><button className="button" disabled={saving||patient.status==='ARCHIVED'}>{saving?'Guardando…':'Guardar evaluación'}</button></div>
        </form>
      </section>

      <section className="patient-record-card"><div className="task-list-heading"><div><h2>Historial y evolución</h2><p>{items.length} evaluaciones registradas</p></div></div>
        <div className="assessment-history">{items.map((item,index)=>{const previous=items.slice(index+1).find(i=>i.scaleCode===item.scaleCode);const delta=previous?item.totalScore-previous.totalScore:null;return <article key={item.id}><div className="assessment-score"><strong>{item.totalScore}</strong><span>{item.scaleName}</span></div><div className="assessment-result"><div><h3>{item.severity}</h3><span>{fmt(item.administeredAt)}{delta!==null?` · ${delta>0?'+':''}${delta} puntos`:''}</span></div><p>{item.interpretation}</p>{item.riskFlag&&<div className="assessment-risk">Requiere valoración clínica prioritaria</div>}{item.clinicalNotes&&<blockquote>{item.clinicalNotes}</blockquote>}</div><button className="assessment-delete" onClick={()=>remove(item)}>Eliminar</button></article>})}{items.length===0&&<div className="therapy-empty"><strong>Todavía no hay evaluaciones</strong><p>Completa la primera escala para empezar a visualizar la evolución.</p></div>}</div>
      </section>
    </div>
  </main></div>;
}
