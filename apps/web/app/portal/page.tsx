'use client';
import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { chargeStatusLabel } from '@/lib/billing';
import Icon, { EmptyState, IconName } from '@/components/Icon';
import PortalBooking from '@/components/PortalBooking';

const TASK_STATUS:Record<PortalTask['status'],{label:string;tone:string}>={PENDING:{label:'Pendiente',tone:'chip-violet'},IN_PROGRESS:{label:'En curso',tone:'chip-blue'},SUBMITTED:{label:'Entregada para revisión',tone:'chip-amber'},CHANGES_REQUESTED:{label:'Tu profesional ha solicitado cambios',tone:'chip-amber'},COMPLETED:{label:'Completada',tone:'chip-green'}};
function CardTitle({icon,children}:{icon:IconName;children:React.ReactNode}){return <h2 className="portal-card-title"><span className="portal-card-icon"><Icon name={icon} size={18}/></span>{children}</h2>}

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
   if(messages.ok){try{setConversation(await messages.json())}catch{setConversation(null)}}
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
 if(!data)return <main className="portal-shell"><p className="portal-loading" role="status">Cargando tu espacio…</p></main>;
 if(data.mustChangePassword)return <main className="portal-login"><section><span className="eyebrow">Seguridad de la cuenta</span><h1>Cambia tu contraseña temporal</h1><p>Para continuar, crea una contraseña personal que solo tú conozcas.</p>{error&&<div className="agenda-error">{error}</div>}<form onSubmit={changePassword}><label>Contraseña temporal<input name="currentPassword" type="password" autoComplete="current-password" required/></label><label>Nueva contraseña<input name="newPassword" type="password" minLength={12} autoComplete="new-password" required/></label><label>Repite la nueva contraseña<input name="confirmPassword" type="password" minLength={12} autoComplete="new-password" required/></label><button className="button primary" disabled={busy}>{busy?'Guardando…':'Cambiar contraseña y continuar'}</button></form><button className="button secondary" onClick={logout}>Cerrar sesión</button></section></main>;

 return <main className="portal-shell"><header className="portal-header"><div><span className="eyebrow">Portal del paciente</span><h1>Hola, {data.patient.firstName}</h1><p>Información práctica de tu proceso, sin notas clínicas internas.</p></div><button onClick={logout} className="portal-logout"><Icon name="logout" size={18}/>Cerrar sesión</button></header>
 {error&&<div className="agenda-error">{error}</div>}{message&&<div className="patient-save-state">{message}</div>}
 <section className="portal-grid"><article className="portal-card"><CardTitle icon="calendar">Próximas citas</CardTitle>{data.sessions.map(s=><div className="portal-item" key={s.id}><strong>{new Date(s.startsAt).toLocaleString('es-ES',{dateStyle:'medium',timeStyle:'short'})}</strong><span>{s.type} · {s.location||'Ubicación pendiente'}</span>{s.videoCallUrl&&<a href={s.videoCallUrl} target="_blank" rel="noreferrer">Acceder a videollamada</a>}</div>)}{!data.sessions.length&&<EmptyState icon="calendar" title="Sin citas próximas" compact>Cuando tu profesional programe una cita, aparecerá aquí.</EmptyState>}</article>
 <PortalBooking/>
 <article className="portal-card portal-tasks"><CardTitle icon="clipboard">Tareas terapéuticas</CardTitle><p className="portal-card-intro">Este espacio sirve para trabajar entre sesiones. Una fecha es orientativa, no una penalización.</p>{data.tasks.map(t=><div className={`portal-item portal-task${['PENDING','IN_PROGRESS','CHANGES_REQUESTED'].includes(t.status)?' portal-task-open':''}`} key={t.id}><span className={`ui-chip ${TASK_STATUS[t.status]?.tone??'chip-neutral'}`}>{TASK_STATUS[t.status]?.label??'Completada'}</span><strong>{t.title}</strong><span>{t.instructions||'Sin instrucciones adicionales'}</span><small className="portal-task-date"><Icon name="clock" size={14}/>{t.dueDate?`Fecha orientativa: ${new Date(t.dueDate).toLocaleDateString('es-ES')}`:'Sin fecha límite'}</small>{t.reviewComment&&<div className="patient-save-state"><strong>Devolución de tu profesional</strong><p>{t.reviewComment}</p></div>}{['PENDING','IN_PROGRESS','CHANGES_REQUESTED'].includes(t.status)&&<><label className="field">Tu respuesta<textarea id={`task-response-${t.id}`} rows={5} maxLength={5000} defaultValue={t.patientFeedback||''} placeholder="Escribe aquí tu experiencia, registro o reflexión…"/></label><div className="patient-record-actions"><button className="button secondary" disabled={busy} onClick={()=>saveTask(t)}>Guardar progreso</button><button className="button primary" disabled={busy} onClick={()=>submitTask(t)}>Entregar para revisión</button></div></>}{t.status==='SUBMITTED'&&<p>La tarea está entregada. Podrás editarla de nuevo si tu profesional solicita cambios.</p>}{t.status==='COMPLETED'&&<p>Revisión completada por tu profesional.</p>}</div>)}{!data.tasks.length&&<EmptyState icon="checkCircle" title="No tienes tareas activas" compact>Si tu profesional te propone un ejercicio, lo verás aquí.</EmptyState>}</article>
 <article className="portal-card portal-messages"><CardTitle icon="message">Mensajes</CardTitle><p className="portal-card-intro">Canal asíncrono. No está destinado a urgencias ni garantiza respuesta inmediata.</p>{conversation?<><div className="portal-message-stream">{conversation.messages.map(m=><div key={m.id} className={`message-bubble ${m.senderType==='PATIENT'?'professional':'patient'}`}><span>{m.senderType==='PATIENT'?'Tú':'Tu profesional'}</span><p>{m.body}</p><small>{new Date(m.createdAt).toLocaleString('es-ES')}</small></div>)}</div><form onSubmit={sendMessage} className="message-composer"><label className="field">Escribe un mensaje<textarea name="body" rows={3} maxLength={4000} required disabled={conversation.status!=='OPEN'||!conversation.patientCanReply}/></label><button className="button primary" disabled={busy||conversation.status!=='OPEN'||!conversation.patientCanReply}>{conversation.status!=='OPEN'||!conversation.patientCanReply?'Mensajería cerrada':busy?'Enviando…':'Enviar mensaje'}</button></form></>:<p>Tu profesional todavía no ha habilitado una conversación.</p>}</article>
 <article className="portal-card"><CardTitle icon="book">Recursos compartidos</CardTitle>{data.resources.map(s=><div className="portal-item" key={s.id}><strong>{s.resource.title}</strong><span>{s.resource.description||'Material compartido por tu profesional'}</span>{s.resource.url&&<a href={s.resource.url} target="_blank" rel="noreferrer">Abrir recurso</a>}{s.resource.type==='FILE'&&<small>{s.resource.fileName||'Archivo protegido'}</small>}</div>)}{!data.resources.length&&<EmptyState icon="book" title="No tienes recursos compartidos." compact />}</article>
 <article className="portal-card"><CardTitle icon="file">Consentimientos</CardTitle>{data.consents.map(c=><div className="portal-item" key={c.id}><strong>{c.title}</strong><span>{c.status}</span></div>)}{!data.consents.length&&<EmptyState icon="file" title="No hay consentimientos disponibles." compact />}</article>
 <article className="portal-card"><CardTitle icon="wallet">Pagos</CardTitle>{data.invoices.map(i=><div className="portal-item" key={i.id}><strong>{i.invoiceNumber} · {money(i.totalCents,i.currency)}</strong><span>{chargeStatusLabel(i.status)} · Pendiente {money(i.totalCents-i.paidCents,i.currency)}</span></div>)}{!data.invoices.length&&<EmptyState icon="wallet" title="No tienes pagos registrados." compact />}</article>
 <article className="portal-card"><CardTitle icon="bell">Notificaciones</CardTitle>{items.map(n=><div className="portal-item" key={n.id}><strong>{n.title}</strong><span>{n.body}</span><small>{new Date(n.createdAt).toLocaleString('es-ES')}</small>{n.status!=='READ'&&<button className="button secondary" onClick={()=>mark(n.id)}>Marcar como leída</button>}</div>)}{!items.length&&<EmptyState icon="bell" title="No tienes notificaciones pendientes." compact />}</article>
 <article className="portal-card"><CardTitle icon="shield">Preferencias de avisos</CardTitle>{pref&&<div className="stack">{([['appointmentReminders','Citas'],['taskReminders','Tareas'],['consentReminders','Consentimientos'],['invoiceReminders','Pagos'],['emailEnabled','Correo electrónico'],['smsEnabled','SMS']] as const).map(([k,l])=><label className="patient" key={k}><span>{l}</span><input type="checkbox" checked={Boolean(pref[k])} onChange={e=>setPref({...pref,[k]:e.target.checked})}/></label>)}<label className="field">Horas de antelación<input type="number" min="1" max="168" value={pref.reminderHoursBefore} onChange={e=>setPref({...pref,reminderHoursBefore:Number(e.target.value)})}/></label><button className="button primary" onClick={savePreferences} disabled={busy}>{busy?'Guardando…':'Guardar preferencias'}</button></div>}</article>
 </section></main>}
