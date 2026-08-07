'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';
export default function PortalLoginPage(){
  const router=useRouter(); const [email,setEmail]=useState(''); const [password,setPassword]=useState(''); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');try{const r=await fetch(`${API}/portal/auth/login`,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.message||'No se pudo iniciar sesión');router.replace('/portal');}catch(e){setError(e instanceof Error?e.message:'Error de acceso');}finally{setBusy(false)}}
  return <main className="portal-login"><section><span className="eyebrow">AsePsico</span><h1>Tu espacio terapéutico</h1><p>Consulta tus próximas citas, tareas, consentimientos y facturas de forma segura.</p>{error&&<div className="agenda-error">{error}</div>}<form onSubmit={submit}><label>Correo electrónico<input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>Contraseña<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} minLength={10} required/></label><button className="button primary" disabled={busy}>{busy?'Accediendo…':'Entrar'}</button></form><small>Este portal no sustituye los canales de urgencia. Ante una emergencia, contacta con los servicios correspondientes.</small></section></main>;
}
