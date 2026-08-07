'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
export default function LoginPage() {
  const router = useRouter(); const [error,setError]=useState('');
  async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setError('');const data=new FormData(e.currentTarget);try{await api('/auth/login',{method:'POST',body:JSON.stringify({email:data.get('email'),password:data.get('password')})});router.push('/patients');}catch(err){setError(err instanceof Error?err.message:'No se pudo iniciar sesión');}}
  return <main className="shell"><div className="card" style={{maxWidth:460,margin:'80px auto'}}><div className="brand">AsePsico</div><h1>Accede a tu consulta</h1><p className="muted">Demo: demo@asepsico.es / AsePsico2026!</p><form onSubmit={submit}><label className="field">Correo<input name="email" type="email" defaultValue="demo@asepsico.es" required/></label><label className="field">Contraseña<input name="password" type="password" defaultValue="AsePsico2026!" required/></label>{error&&<p className="error">{error}</p>}<button className="button" type="submit">Entrar</button></form></div></main>;
}
