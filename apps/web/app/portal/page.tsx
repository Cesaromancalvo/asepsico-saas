'use client';
import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const API=process.env.NEXT_PUBLIC_API_URL||'http://localhost:4000/api/v1';
type NotificationItem={id:string;title:string;body:string;status:string;createdAt:string;actionUrl?:string};
type Pref={appointmentReminders:boolean;taskReminders:boolean;consentReminders:boolean;invoiceReminders:boolean;emailEnabled:boolean;smsEnabled:boolean;reminderHoursBefore:number};
type PortalMessage={id:string;senderType:'PROFESSIONAL'|'PATIENT';body:string;createdAt:string};
type PortalConversation={id:string;status:'OPEN'|'CLOSED'|'ARCHIVED';patientCanReply:boolean;messages:PortalMessage[]}|null;
type PortalTask={id:string;title:string;instructions?:string;status:'PENDING'|'IN_PROGRESS'|'SUBMITTED'|'CHANGES_REQUESTED'|'COMPLETED';dueDate?:string;patientFeedback?:string;reviewComment?:string;submittedAt?:string;completedAt?:string};
type Dashboard={patient:{firstName:string;lastName:string};sessions:any[];tasks:PortalTask[];consents:any[];invoices:any[];resources:Array<{id:string;sharedAt:string;resource:{id:string;title:string;description?:string;type:'LINK'|'FILE';category:string;url?:string;fileName?:string}}> ;mustChangePassword:boolean};
const money=(c:number,cur='EUR')=>new Intl.NumberFormat('es-ES',{style:'currency',currency:cur}).format(c/100);
function csrf(){return decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('csrf_token='))?.split('=')[1]||'')}
async function readJson(response:Response){return response.json().catch(()=>({}));}

export default function PortalPage(){
 const router=useRouter();
 const [data,setData]=useState<Dashboard|null>(null);
 const [items,setItems]=useState<NotificationItem[]>([]);
 const [pref,setPref]=useState<Pref|null>(null);
 const [conversation,setConversation]=useState<PortalConversation>(null);
 const [error,setError]=useState('');
 const [message,setMessage]=useState('');
 const [busy,setBusy]=useState(false);

 async function load(){
  const dashboard=await fetch(`${API}/portal/dashboard`,{credentials:'include'});
  if(dashboard.status===401){router.replace('/portal/login');return}
  const body=await readJson(dashboard);
  if(!dashboard.ok)throw new Error(body.message||'No se pudo cargar el portal');
  setData(body);
  if(!body.mustChangePassword){
   const [notifications,preferences,messages]=await Promise.all([
    fetch(`${API}/portal/notifications`,{credentials:'include'}),
    fetch(`${API}/portal/notifications/preferences`,{credentials:'include'}),
    fetch(`${API}/portal/messages`,{credentials:'include'}),
   ]);
   if(notifications.ok)setItems(await notifications.json());
   if(preferences.ok)setPref(await preferences.json());
   if(messages.ok)setConversation(await messages.json());
  }
 }
 useEffect(()=>{load().catch(e=>setError(e.message))},[]);

 async function logout(){await fetch(`${API}/portal/auth/logout`,{method:'POST',credentials:'include',headers:{'x-csrf-token':csrf()}});router.replace('/portal/login')}
 async function changePassword(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setBusy(true);setError('');
  const form=e.currentTarget;const fd=new FormData(form);const next=String(fd.get('newPassword')||'');
  if(next!==String(fd.get('confirmPassword')||'')){setError('Las nuevas contraseñas no coinciden');setBusy(false);return}
  const r=await fetch(`${API}/portal/password`,{method:'PATCH',credentials:'include',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify({currentPassword:fd.get('currentPassword'),newPassword:next})});
  const body=await readJson(r);setBusy(false);
  if(!r.ok){setError(body.message||'No se pudo cambiar la contraseña');return}
  form.reset();setMessage('Contraseña actualizada correctamente.');await load();
 }
 async function mark(id:string){
  const r=await fetch(`${API}/portal/notifications/${id}/read`,{method:'PATCH',credentials:'include',headers:{'x-csrf-token':csrf()}});
  if(r.ok)setItems(x=>x.map(n=>n.id===id?{...n,status:'READ'}:n));
 }

 async function sendMessage(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setBusy(true);setError('');setMessage('');
  const form=e.currentTarget;const fd=new FormData(form);const body=String(fd.get('body')||'').trim();
  if(!body){setBusy(false);return}
  const r=await fetch(`${API}/portal/messages`,{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify({body})});
  const result=await readJson(r);setBusy(false);
  if(!r.ok){setError(result.message||'No se pudo enviar el mensaje');return}
  form.reset();setMessage('Mensaje enviado. Tu profesional lo revisará cuando corresponda.');await load();
 }

 async function saveTask(task:PortalTask){
  const el=document.getElementById(`task-response-${task.id}`) as HTMLTextAreaElement|null;
  const patientFeedback=el?.value?.trim()||'';setBusy(true);setError('');setMessage('');
  const r=await fetch(`${API}/portal/tasks/${task.id}/progress`,{method:'PATCH',credentials:'include',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify({patientFeedback})});
  const body=await readJson(r);setBusy(false);if(!r.ok){setError(body.message||'No se pudo guardar el progreso');return}setMessage('Progreso guardado. Puedes continuar más tarde.');await load();
 }
 async function submitTask(task:PortalTask){
  const el=document.getElementById(`task-response-${task.id}`) as HTMLTextAreaElement|null;
  if(el && el.value.trim()!==String(task.patientFeedback||'').trim()){await saveTask(task)}
  setBusy(true);setError('');setMessage('');
  const r=await fetch(`${API}/portal/tasks/${task.id}/submit`,{method:'POST',credentials:'include',headers:{'x-csrf-token':csrf()}});const body=await readJson(r);setBusy(false);
  if(!r.ok){setError(body.message||'No se pudo entregar la tarea');return}setMessage('Tarea entregada. Tu profesional la revisará.');await load();
 }

 async function savePreferences(){
  if(!pref)return;setBusy(true);setMessage('');
  const r=await fetch(`${API}/portal/notifications/preferences`,{method:'PATCH',credentials:'include',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify(pref)});
  const body=await readJson(r);setBusy(false);
  if(!r.ok){setError(body.message||'No se pudieron guardar las preferencias');return}
  setPref(body);setMessage(body.smsEnabled===false&&pref.smsEnabled?'Preferencias guardadas. El SMS permanece desactivado porque no hay teléfono registrado.':'Preferencias guardadas.');
 }

 if(error&&!data)return <main className="portal-shell"><div className="agenda-error">{error}</div></main>;
 if(!data)return <main className="portal-shell"><p>Cargando tu espacio…</p></main>;
 if(data.mustChangePassword)return <main className="portal-login"><section><span className="eyebrow">Seguridad de la cuenta</span><h1>Cambia tu contraseña temporal</h1><p>Para continuar, crea una contraseña personal que solo tú conozcas.</p>{error&&<div className="agenda-error">{error}</div>}<form onSubmit={changePassword}><label>Contraseña temporal<input name="currentPassword" type="password" autoComplete="current-password" required/></label><label>Nueva contraseña<input name="newPassword" type="password" minLength={12} autoComplete="new-password" required/></label><label>Repite la nueva contraseña<input name="confirmPassword" type="password" minLength={12} autoComplete="new-password" required/></label><button className="button primary" disabled={busy}>{busy?'Guardando…':'Cambiar contraseña y continuar'}</button></form><button className="button secondary" onClick={logout}>Cerrar sesión</button></section></main>;

 return <main className="portal-shell"><header><div><span className="eyebrow">Portal del paciente</span><h1>Hola, {data.patient.firstName}</h1><p>Información práctica de tu proceso, sin notas clínicas internas.</p></div><button onClick={logout}>Cerrar sesión</button></header>
 {error&&<div className="agenda-error">{error}</div>}{message&&<div className="patient-save-state">{message}</div>}
 <section className="portal-grid"><article className="portal-card"><h2>Próximas citas</h2>{data.sessions.map(s=><div className="portal-item" key={s.id}><strong>{new Date(s.startsAt).toLocaleString('es-ES',{dateStyle:'medium',timeStyle:'short'})}</strong><span>{s.type} · {s.location||'Ubicación pendiente'}</span>{s.videoCallUrl&&<a href={s.videoCallUrl} target="_blank" rel="noreferrer">Acceder a videollamada</a>}</div>)}{!data.sessions.length&&<p>No tienes próximas citas registradas.</p>}</article>
 <article className="portal-card portal-tasks"><h2>Tareas terapéuticas</h2><p>Este espacio sirve para trabajar entre sesiones. Una fecha es orientativa, no una penalización.</p>{data.tasks.map(t=><div className="portal-item" key={t.id}><strong>{t.title}</strong><span>{t.instructions||'Sin instrucciones adicionales'}</span><small>{t.dueDate?`Fecha orientativa: ${new Date(t.dueDate).toLocaleDateString('es-ES')}`:'Sin fecha límite'} · {t.status==='PENDING'?'Pendiente':t.status==='IN_PROGRESS'?'En curso':t.status==='SUBMITTED'?'Entregada para revisión':t.status==='CHANGES_REQUESTED'?'Tu profesional ha solicitado cambios':'Completada'}</small>{t.reviewComment&&<div className="patient-save-state"><strong>Devolución de tu profesional</strong><p>{t.reviewComment}</p></div>}{['PENDING','IN_PROGRESS','CHANGES_REQUESTED'].includes(t.status)&&<><label className="field">Tu respuesta<textarea id={`task-response-${t.id}`} rows={5} maxLength={5000} defaultValue={t.patientFeedback||''} placeholder="Escribe aquí tu experiencia, registro o reflexión…"/></label><div className="patient-record-actions"><button className="button secondary" disabled={busy} onClick={()=>saveTask(t)}>Guardar progreso</button><button className="button primary" disabled={busy} onClick={()=>submitTask(t)}>Entregar para revisión</button></div></>}{t.status==='SUBMITTED'&&<p>La tarea está entregada. Podrás editarla de nuevo si tu profesional solicita cambios.</p>}{t.status==='COMPLETED'&&<p>Revisión completada por tu profesional.</p>}</div>)}{!data.tasks.length&&<p>No tienes tareas activas.</p>}</article>
 <article className="portal-card portal-messages"><h2>Mensajes</h2><p>Canal asíncrono. No está destinado a urgencias ni garantiza respuesta inmediata.</p>{conversation?<><div className="portal-message-stream">{conversation.messages.map(m=><div key={m.id} className={`message-bubble ${m.senderType==='PATIENT'?'professional':'patient'}`}><span>{m.senderType==='PATIENT'?'Tú':'Tu profesional'}</span><p>{m.body}</p><small>{new Date(m.createdAt).toLocaleString('es-ES')}</small></div>)}</div><form onSubmit={sendMessage} className="message-composer"><label className="field">Escribe un mensaje<textarea name="body" rows={3} maxLength={4000} required disabled={conversation.status!=='OPEN'||!conversation.patientCanReply}/></label><button className="button primary" disabled={busy||conversation.status!=='OPEN'||!conversation.patientCanReply}>{conversation.status!=='OPEN'||!conversation.patientCanReply?'Mensajería cerrada':busy?'Enviando…':'Enviar mensaje'}</button></form></>:<p>Tu profesional todavía no ha habilitado una conversación.</p>}</article>
 <article className="portal-card"><h2>Recursos compartidos</h2>{data.resources.map(s=><div className="portal-item" key={s.id}><strong>{s.resource.title}</strong><span>{s.resource.description||'Material compartido por tu profesional'}</span>{s.resource.url&&<a href={s.resource.url} target="_blank" rel="noreferrer">Abrir recurso</a>}{s.resource.type==='FILE'&&<small>{s.resource.fileName||'Archivo protegido'}</small>}</div>)}{!data.resources.length&&<p>No tienes recursos compartidos.</p>}</article>
 <article className="portal-card"><h2>Consentimientos</h2>{data.consents.map(c=><div className="portal-item" key={c.id}><strong>{c.title}</strong><span>{c.status}</span></div>)}{!data.consents.length&&<p>No hay consentimientos disponibles.</p>}</article>
 <article className="portal-card"><h2>Facturas</h2>{data.invoices.map(i=><div className="portal-item" key={i.id}><strong>{i.invoiceNumber} · {money(i.totalCents,i.currency)}</strong><span>{i.status} · Pendiente {money(i.totalCents-i.paidCents,i.currency)}</span></div>)}{!data.invoices.length&&<p>No hay facturas emitidas.</p>}</article>
 <article className="portal-card"><h2>Notificaciones</h2>{items.map(n=><div className="portal-item" key={n.id}><strong>{n.title}</strong><span>{n.body}</span><small>{new Date(n.createdAt).toLocaleString('es-ES')}</small>{n.status!=='READ'&&<button className="button secondary" onClick={()=>mark(n.id)}>Marcar como leída</button>}</div>)}{!items.length&&<p>No tienes notificaciones pendientes.</p>}</article>
 <article className="portal-card"><h2>Preferencias de avisos</h2>{pref&&<div className="stack">{([['appointmentReminders','Citas'],['taskReminders','Tareas'],['consentReminders','Consentimientos'],['invoiceReminders','Facturas'],['emailEnabled','Correo electrónico'],['smsEnabled','SMS']] as const).map(([k,l])=><label className="patient" key={k}><span>{l}</span><input type="checkbox" checked={Boolean(pref[k])} onChange={e=>setPref({...pref,[k]:e.target.checked})}/></label>)}<label className="field">Horas de antelación<input type="number" min="1" max="168" value={pref.reminderHoursBefore} onChange={e=>setPref({...pref,reminderHoursBefore:Number(e.target.value)})}/></label><button className="button primary" onClick={savePreferences} disabled={busy}>{busy?'Guardando…':'Guardar preferencias'}</button></div>}</article>
 </section></main>}
