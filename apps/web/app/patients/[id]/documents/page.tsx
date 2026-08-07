'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api } from '@/lib/api';

type Patient = { id:string; firstName:string; lastName:string; status:string };
type DocumentItem = { id:string; title:string; type:string; description?:string|null; fileName?:string|null; mimeType?:string|null; storageKey?:string|null; createdAt:string };
type ConsentItem = { id:string; title:string; type:string; status:string; signedAt?:string|null; expiresAt?:string|null; signedBy?:string|null; notes?:string|null; updatedAt:string };
type ReportItem = { id:string; title:string; type:string; status:string; content:string; finalizedAt?:string|null; updatedAt:string };

type Tab = 'documents'|'consents'|'reports';

function fmt(value?:string|null){return value?new Intl.DateTimeFormat('es-ES',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(value)):'—';}
function label(value:string){return value.replaceAll('_',' ').toLowerCase().replace(/^./,c=>c.toUpperCase());}

export default function PatientDocumentsPage(){
  const {id:patientId}=useParams<{id:string}>();
  const [patient,setPatient]=useState<Patient|null>(null);
  const [documents,setDocuments]=useState<DocumentItem[]>([]);
  const [consents,setConsents]=useState<ConsentItem[]>([]);
  const [reports,setReports]=useState<ReportItem[]>([]);
  const [tab,setTab]=useState<Tab>('documents');
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');

  async function load(){
    try{
      setLoading(true); setError('');
      const [p,d,c,r]=await Promise.all([
        api<Patient>(`/patients/${patientId}`),
        api<DocumentItem[]>(`/patients/${patientId}/documents`),
        api<ConsentItem[]>(`/patients/${patientId}/consents`),
        api<ReportItem[]>(`/patients/${patientId}/reports`),
      ]);
      setPatient(p);setDocuments(d);setConsents(c);setReports(r);
    }catch(e){setError(e instanceof Error?e.message:'No se pudo cargar el módulo documental');}
    finally{setLoading(false);}
  }
  useEffect(()=>{load();},[patientId]);

  async function createDocument(e:FormEvent<HTMLFormElement>){
    e.preventDefault(); const form=e.currentTarget; const fd=new FormData(form);
    try{setSaving(true);setError('');await api(`/patients/${patientId}/documents`,{method:'POST',body:JSON.stringify({title:fd.get('title'),type:fd.get('type'),description:fd.get('description')||undefined,fileName:fd.get('fileName')||undefined,mimeType:fd.get('mimeType')||undefined,storageKey:fd.get('storageKey')||undefined})});form.reset();await load();}
    catch(e){setError(e instanceof Error?e.message:'No se pudo registrar el documento');}finally{setSaving(false);}
  }
  async function createConsent(e:FormEvent<HTMLFormElement>){
    e.preventDefault(); const form=e.currentTarget; const fd=new FormData(form);
    try{setSaving(true);setError('');await api(`/patients/${patientId}/consents`,{method:'POST',body:JSON.stringify({title:fd.get('title')||undefined,type:fd.get('type'),status:fd.get('status'),signedAt:fd.get('signedAt')||undefined,expiresAt:fd.get('expiresAt')||undefined,signedBy:fd.get('signedBy')||undefined,notes:fd.get('notes')||undefined})});form.reset();await load();}
    catch(e){setError(e instanceof Error?e.message:'No se pudo registrar el consentimiento');}finally{setSaving(false);}
  }
  async function createReport(e:FormEvent<HTMLFormElement>){
    e.preventDefault(); const form=e.currentTarget; const fd=new FormData(form);
    try{setSaving(true);setError('');await api(`/patients/${patientId}/reports`,{method:'POST',body:JSON.stringify({title:fd.get('title'),type:fd.get('type'),status:fd.get('status'),content:fd.get('content')})});form.reset();await load();}
    catch(e){setError(e instanceof Error?e.message:'No se pudo crear el informe');}finally{setSaving(false);}
  }
  async function markConsentSigned(item:ConsentItem){
    const signedBy=window.prompt('Nombre de la persona firmante');
    if(!signedBy)return;
    try{await api(`/patients/${patientId}/consents/${item.id}`,{method:'PATCH',body:JSON.stringify({status:'SIGNED',signedAt:new Date().toISOString(),signedBy})});await load();}
    catch(e){setError(e instanceof Error?e.message:'No se pudo firmar el consentimiento');}
  }

  async function remove(kind:Tab,id:string){if(!window.confirm('¿Eliminar este registro?'))return;const endpoint=kind==='documents'?'documents':kind==='consents'?'consents':'reports';try{await api(`/patients/${patientId}/${endpoint}/${id}`,{method:'DELETE'});await load();}catch(e){setError(e instanceof Error?e.message:'No se pudo eliminar');}}

  const summary=useMemo(()=>({signed:consents.filter(c=>c.status==='SIGNED').length,final:reports.filter(r=>r.status==='FINAL').length,pending:consents.filter(c=>c.status==='PENDING').length}),[consents,reports]);
  if(loading)return <div className="app-layout"><Sidebar/><main className="documents-page"><div className="patient-record-loading">Cargando documentos…</div></main></div>;
  if(!patient)return <div className="app-layout"><Sidebar/><main className="documents-page"><div className="agenda-error">{error||'Paciente no encontrado'}</div></main></div>;

  return <div className="app-layout"><Sidebar syncText="Gestión documental"/><main className="documents-page">
    <header className="patient-plan-header"><div><Link href={`/patients/${patient.id}`} className="patient-record-back">← Volver a la ficha clínica</Link><div className="patient-record-kicker">Sprint 5 · Documentación</div><h1>Documentos e informes de {patient.firstName} {patient.lastName}</h1><p>Registro documental, consentimientos y elaboración trazable de informes clínicos.</p></div><div className="patient-record-actions"><Link href={`/patients/${patient.id}/assessments`} className="button secondary">Escalas</Link><Link href={`/patients/${patient.id}/plan`} className="button secondary">Plan</Link></div></header>
    {error&&<div className="agenda-error">{error}</div>}

    <section className="document-summary-grid"><article><span>Documentos</span><strong>{documents.length}</strong><small>Registros clínicos y administrativos</small></article><article><span>Consentimientos firmados</span><strong>{summary.signed}</strong><small>{summary.pending} pendientes</small></article><article><span>Informes finales</span><strong>{summary.final}</strong><small>{reports.length} informes totales</small></article></section>

    <nav className="document-tabs"><button className={tab==='documents'?'active':''} onClick={()=>setTab('documents')}>Documentos</button><button className={tab==='consents'?'active':''} onClick={()=>setTab('consents')}>Consentimientos</button><button className={tab==='reports'?'active':''} onClick={()=>setTab('reports')}>Informes</button></nav>

    {tab==='documents'&&<div className="document-layout"><section className="patient-record-card"><h2>Registrar documento</h2><p className="document-help">La versión actual registra metadatos y una referencia segura de almacenamiento. El contenido binario debe alojarse en un proveedor privado compatible con RGPD.</p><form className="document-form" onSubmit={createDocument}><label><span>Título</span><input name="title" required maxLength={180}/></label><label><span>Tipo</span><select name="type"><option value="CLINICAL">Clínico</option><option value="REFERRAL">Derivación</option><option value="ADMINISTRATIVE">Administrativo</option><option value="EXTERNAL_REPORT">Informe externo</option><option value="OTHER">Otro</option></select></label><label><span>Descripción</span><textarea name="description" maxLength={5000}/></label><div className="document-form-grid"><label><span>Nombre del archivo</span><input name="fileName" maxLength={255}/></label><label><span>Tipo MIME</span><input name="mimeType" placeholder="application/pdf" maxLength={120}/></label></div><label><span>Referencia segura de almacenamiento</span><input name="storageKey" placeholder="private/patients/..." maxLength={500}/></label><button className="button" disabled={saving||patient.status==='ARCHIVED'}>{saving?'Guardando…':'Registrar documento'}</button></form></section><section className="patient-record-card"><h2>Archivo documental</h2><div className="document-list">{documents.map(item=><article key={item.id}><div><span className="document-badge">{label(item.type)}</span><h3>{item.title}</h3><p>{item.description||item.fileName||'Sin descripción'}</p><small>{fmt(item.createdAt)}{item.fileName?` · ${item.fileName}`:''}</small></div><button onClick={()=>remove('documents',item.id)}>Eliminar</button></article>)}{documents.length===0&&<div className="therapy-empty"><strong>Sin documentos</strong><p>Registra el primer documento asociado al paciente.</p></div>}</div></section></div>}

    {tab==='consents'&&<div className="document-layout"><section className="patient-record-card"><h2>Registrar consentimiento</h2><form className="document-form" onSubmit={createConsent}><label><span>Tipo</span><select name="type"><option value="DATA_PROCESSING">Tratamiento de datos</option><option value="INFORMED_CONSENT">Consentimiento informado</option><option value="TELEPSYCHOLOGY">Telepsicología</option><option value="MINOR_GUARDIAN">Tutor de menor</option><option value="COMMUNICATIONS">Comunicaciones</option><option value="OTHER">Otro</option></select></label><label><span>Título personalizado</span><input name="title" maxLength={180}/></label><label><span>Estado</span><select name="status"><option value="PENDING">Pendiente</option><option value="SIGNED">Firmado</option><option value="REVOKED">Revocado</option><option value="EXPIRED">Caducado</option></select></label><div className="document-form-grid"><label><span>Fecha de firma</span><input type="date" name="signedAt"/></label><label><span>Fecha de caducidad</span><input type="date" name="expiresAt"/></label></div><label><span>Firmado por</span><input name="signedBy" maxLength={180}/></label><label><span>Notas</span><textarea name="notes" maxLength={3000}/></label><button className="button" disabled={saving||patient.status==='ARCHIVED'}>Guardar consentimiento</button></form></section><section className="patient-record-card"><h2>Estado de consentimientos</h2><div className="document-list">{consents.map(item=><article key={item.id}><div><span className={`document-badge status-${item.status.toLowerCase()}`}>{label(item.status)}</span><h3>{item.title}</h3><p>{label(item.type)}{item.signedBy?` · ${item.signedBy}`:''}</p><small>Firma: {fmt(item.signedAt)} · Caduca: {fmt(item.expiresAt)}</small></div><div className="document-row-actions">{item.status==='PENDING'&&<button onClick={()=>markConsentSigned(item)}>Marcar firmado</button>}<button onClick={()=>remove('consents',item.id)}>Eliminar</button></div></article>)}{consents.length===0&&<div className="therapy-empty"><strong>Sin consentimientos</strong><p>Registra el consentimiento informado o de protección de datos.</p></div>}</div></section></div>}

    {tab==='reports'&&<div className="document-layout"><section className="patient-record-card"><h2>Nuevo informe clínico</h2><form className="document-form" onSubmit={createReport}><label><span>Título</span><input name="title" required maxLength={180}/></label><div className="document-form-grid"><label><span>Tipo</span><select name="type"><option value="EVOLUTION">Evolución</option><option value="DISCHARGE">Alta</option><option value="REFERRAL">Derivación</option><option value="CERTIFICATE">Certificado</option><option value="CUSTOM">Personalizado</option></select></label><label><span>Estado</span><select name="status"><option value="DRAFT">Borrador</option><option value="FINAL">Final</option></select></label></div><label><span>Contenido</span><textarea name="content" required maxLength={30000} className="report-editor" placeholder="Redacta el informe con lenguaje clínico objetivo y verificable…"/></label><button className="button" disabled={saving||patient.status==='ARCHIVED'}>Guardar informe</button></form></section><section className="patient-record-card"><h2>Informes generados</h2><div className="document-list report-list">{reports.map(item=><article key={item.id}><div><span className={`document-badge status-${item.status.toLowerCase()}`}>{label(item.status)}</span><h3>{item.title}</h3><p>{item.content.slice(0,220)}{item.content.length>220?'…':''}</p><small>{label(item.type)} · actualizado {fmt(item.updatedAt)}</small></div>{item.status!=='FINAL'&&<button onClick={()=>remove('reports',item.id)}>Eliminar</button>}</article>)}{reports.length===0&&<div className="therapy-empty"><strong>Sin informes</strong><p>Crea un borrador de evolución, derivación o alta.</p></div>}</div></section></div>}
  </main></div>;
}
