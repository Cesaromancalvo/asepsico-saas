'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import Sidebar from '../../components/Sidebar';

type Conversation = {
  id: string;
  status: 'OPEN' | 'CLOSED' | 'ARCHIVED';
  patientCanReply: boolean;
  updatedAt: string;
  patient: { id: string; firstName: string; lastName: string };
  messages: Array<{ id: string; body: string; senderType: 'PROFESSIONAL' | 'PATIENT'; createdAt: string }>;
  _count: { messages: number };
  unreadCount: number;
};

type Thread = Conversation & {
  messages: Array<{ id: string; body: string; senderType: 'PROFESSIONAL' | 'PATIENT'; createdAt: string; attachmentName?: string }>;
};

export default function MessagesPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [thread, setThread] = useState<Thread | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadList(q = '') {
    const rows = await api<Conversation[]>(`/messages${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    setConversations(rows);
    if (!selectedId && rows[0]) setSelectedId(rows[0].id);
  }

  async function loadThread(id: string) {
    if (!id) return;
    const row = await api<Thread>(`/messages/${id}`);
    setThread(row);
  }

  useEffect(() => {
    const patientId = new URLSearchParams(window.location.search).get('patientId');
    (async () => {
      if (patientId) {
        const conversation = await api<Conversation>(`/patients/${patientId}/conversation`, { method: 'POST' });
        setSelectedId(conversation.id);
      }
      await loadList();
    })().catch(e => setError(e.message));
  }, []);
  useEffect(() => { if (selectedId) loadThread(selectedId).catch(e => setError(e.message)); }, [selectedId]);

  const selected = useMemo(() => conversations.find(c => c.id === selectedId), [conversations, selectedId]);

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedId) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const body = String(fd.get('body') || '').trim();
    if (!body) return;
    setBusy(true); setError('');
    try {
      await api(`/messages/${selectedId}`, { method: 'POST', body: JSON.stringify({ body }) });
      form.reset();
      await Promise.all([loadThread(selectedId), loadList(search)]);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function updateConversation(patch: Record<string, unknown>) {
    if (!selectedId) return;
    setBusy(true); setError('');
    try {
      await api(`/messages/${selectedId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await Promise.all([loadThread(selectedId), loadList(search)]);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="app-layout">
      <Sidebar syncText="Mensajería conectada con pacientes" />
      <main className="messages-page">
        <header className="page-header">
          <div><span className="eyebrow">Continuidad entre sesiones</span><h1>Mensajes</h1><p>Comunicación asíncrona y estructurada. No es un canal de urgencias.</p></div>
        </header>
        {error && <div className="agenda-error">{error}</div>}
        <section className="messages-layout">
          <aside className="messages-list">
            <label className="field">Buscar paciente<input value={search} onChange={e => { setSearch(e.target.value); loadList(e.target.value).catch(err => setError(err.message)); }} placeholder="Nombre o apellidos" /></label>
            {conversations.map(c => <button key={c.id} type="button" className={`conversation-row ${selectedId === c.id ? 'active' : ''}`} onClick={() => setSelectedId(c.id)}>
              <strong>{c.patient.firstName} {c.patient.lastName}</strong>
              <span>{c.messages[0]?.body || 'Sin mensajes todavía'}</span>
              <small>{c.status === 'OPEN' ? 'Abierta' : 'Cerrada'} · {c._count.messages} mensajes{c.unreadCount ? ` · ${c.unreadCount} sin leer` : ''}</small>
            </button>)}
            {!conversations.length && <div className="empty-state"><strong>No hay conversaciones</strong><p>Las conversaciones se crean desde la ficha del paciente.</p></div>}
          </aside>
          <article className="message-thread">
            {!thread ? <div className="empty-state"><strong>Selecciona una conversación</strong><p>Aquí verás el historial completo.</p></div> : <>
              <header className="thread-header"><div><h2><a href={`/patients/${thread.patient.id}`}>{thread.patient.firstName} {thread.patient.lastName}</a></h2><p>{thread.status === 'OPEN' ? 'Conversación abierta' : 'Conversación cerrada'} · {thread.patientCanReply ? 'El paciente puede responder' : 'Respuestas del paciente bloqueadas'}</p></div><div className="thread-actions">
                <button className="button secondary" disabled={busy} onClick={() => updateConversation({ patientCanReply: !thread.patientCanReply })}>{thread.patientCanReply ? 'Bloquear respuestas' : 'Permitir respuestas'}</button>
                <button className="button secondary" disabled={busy} onClick={() => updateConversation({ status: thread.status === 'OPEN' ? 'CLOSED' : 'OPEN' })}>{thread.status === 'OPEN' ? 'Cerrar conversación' : 'Reabrir conversación'}</button>
                <button className="button secondary" disabled={busy} onClick={() => { if (window.confirm('La conversación dejará de aparecer en la bandeja, pero conservará su historial. ¿Archivar?')) updateConversation({ status: 'ARCHIVED' }).then(() => { setThread(null); setSelectedId(''); loadList(search); }); }}>Archivar</button>
              </div></header>
              <div className="urgent-boundary"><strong>Importante:</strong> este canal no sustituye la atención urgente. Ante una emergencia, utiliza los recursos asistenciales correspondientes.</div>
              <div className="message-stream">{thread.messages.map(m => <div key={m.id} className={`message-bubble ${m.senderType === 'PROFESSIONAL' ? 'professional' : 'patient'}`}><span>{m.senderType === 'PROFESSIONAL' ? 'Profesional' : 'Paciente'}</span><p>{m.body}</p><small>{new Date(m.createdAt).toLocaleString('es-ES')}</small></div>)}{!thread.messages.length && <p className="muted">Todavía no hay mensajes.</p>}</div>
              <form className="message-composer" onSubmit={send}><label className="field">Nuevo mensaje<textarea name="body" maxLength={4000} rows={4} placeholder="Escribe una indicación breve y clara…" disabled={thread.status !== 'OPEN'} required /></label><div><small>No incluyas información innecesaria en notificaciones externas.</small><button className="button primary" disabled={busy || thread.status !== 'OPEN'}>{busy ? 'Enviando…' : 'Enviar mensaje'}</button></div></form>
            </>}
          </article>
        </section>
      </main>
    </div>
  );
}
