'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { isForbidden, therapistName, useViewer } from '../../lib/clinical';
import Sidebar from '../../components/Sidebar';

type Conversation = {
  id: string;
  status: 'OPEN' | 'CLOSED' | 'ARCHIVED';
  patientCanReply: boolean;
  updatedAt: string;
  lastActivityAt?: string;
  patient: { id: string; firstName: string; lastName: string };
  messages: Array<{ id: string; body: string; senderType: 'PROFESSIONAL' | 'PATIENT'; createdAt: string }>;
  // E1: vista previa y no leídos solo si trata al paciente. Si no, solo metadatos.
  canReadMessages?: boolean;
  unreadCount: number | null;
};

type Thread = Omit<Conversation, 'messages' | 'canReadMessages' | 'unreadCount'> & {
  /** Autor de un proceso ya no activo: lee lo suyo, pero no escribe ni gestiona. */
  readOnly?: boolean;
  messages: Array<{ id: string; body: string; senderType: 'PROFESSIONAL' | 'PATIENT'; createdAt: string; attachmentName?: string }>;
};

type PatientSummary = { summary?: { therapist?: { firstName: string; lastName: string } | null } };

const STATUS_LABEL: Record<Conversation['status'], string> = { OPEN: 'Abierta', CLOSED: 'Cerrada', ARCHIVED: 'Archivada' };

function formatDateTime(value?: string | null) {
  if (!value) return 'Sin actividad';
  return new Date(value).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function MessagesPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [thread, setThread] = useState<Thread | null>(null);
  // Profesional del paciente de una conversación sin acceso (dato administrativo de la ficha).
  const [professional, setProfessional] = useState<{ patientId: string; name: string } | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  // Conversación en la que el usuario ha pedido ver sus mensajes de un tratamiento anterior.
  const [historyRequested, setHistoryRequested] = useState('');
  const viewer = useViewer();

  async function loadList(q = '') {
    const rows = await api<Conversation[]>(`/messages${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    setConversations(rows);
    setSelectedId((current) => current || rows[0]?.id || '');
    return rows;
  }

  async function loadThread(id: string) {
    if (!id) return;
    setLoadingThread(true);
    try {
      setThread(await api<Thread>(`/messages/${id}`));
    } finally {
      setLoadingThread(false);
    }
  }

  useEffect(() => {
    const patientId = new URLSearchParams(window.location.search).get('patientId');
    (async () => {
      let openedId = '';
      if (patientId) {
        try {
          const conversation = await api<Conversation>(`/patients/${patientId}/conversation`, { method: 'POST' });
          openedId = conversation.id;
        } catch (err) {
          // 403: no trata al paciente. Se muestra su conversación (si existe) solo con metadatos.
          if (!isForbidden(err)) throw err;
        }
      }
      const rows = await loadList();
      const target = openedId || (patientId ? rows.find((row) => row.patient.id === patientId)?.id : '') || '';
      if (target) setSelectedId(target);
    })()
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudieron cargar los mensajes'))
      .finally(() => setLoadingList(false));
  }, []);

  const selected = useMemo(() => conversations.find((c) => c.id === selectedId), [conversations, selectedId]);
  const metadataOnly = selected?.canReadMessages === false && historyRequested !== selectedId;

  async function openOwnHistory() {
    if (!selectedId) return;
    setError('');
    try {
      setHistoryRequested(selectedId);
      await loadThread(selectedId);
    } catch (err) {
      setHistoryRequested('');
      setError(isForbidden(err) ? 'No hay mensajes tuyos con este paciente.' : err instanceof Error ? err.message : 'No se pudo cargar la conversación');
    }
  }

  useEffect(() => {
    setThread(null);
    if (!selectedId || !selected) return;
    if (metadataOnly) {
      // No se pide el hilo: la API respondería 403 (y lo auditaría). Solo el profesional, de la ficha.
      if (professional?.patientId === selected.patient.id) return;
      api<PatientSummary>(`/patients/${selected.patient.id}`)
        .then((patient) => setProfessional({ patientId: selected.patient.id, name: therapistName(patient.summary?.therapist) }))
        .catch(() => setProfessional({ patientId: selected.patient.id, name: 'No disponible' }));
      return;
    }
    if (historyRequested === selectedId) return; // ya lo cargó openOwnHistory
    loadThread(selectedId).catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar la conversación'));
  }, [selectedId, selected?.canReadMessages, metadataOnly]);

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
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo enviar el mensaje'); }
    finally { setBusy(false); }
  }

  async function updateConversation(patch: Record<string, unknown>) {
    if (!selectedId) return;
    setBusy(true); setError('');
    try {
      await api(`/messages/${selectedId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await Promise.all([loadThread(selectedId), loadList(search)]);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo actualizar la conversación'); }
    finally { setBusy(false); }
  }

  const readOnly = thread?.readOnly === true;

  return (
    <div className="app-layout">
      <Sidebar syncText="Mensajería conectada con pacientes" />
      <main className="messages-page">
        <header className="page-header">
          <div><span className="eyebrow">Continuidad entre sesiones</span><h1>Mensajes</h1><p>Comunicación asíncrona y estructurada. No es un canal de urgencias.</p></div>
        </header>
        {error && <div className="agenda-error" role="alert">{error}</div>}
        <section className="messages-layout">
          <aside className="messages-list" aria-label="Conversaciones">
            <label className="field">Buscar paciente<input value={search} onChange={e => { setSearch(e.target.value); loadList(e.target.value).catch(err => setError(err.message)); }} placeholder="Nombre o apellidos" /></label>
            {loadingList && <p className="muted" role="status">Cargando conversaciones…</p>}
            {conversations.map(c => <button key={c.id} type="button" aria-current={selectedId === c.id ? 'true' : undefined} className={`conversation-row ${selectedId === c.id ? 'active' : ''}`} onClick={() => setSelectedId(c.id)}>
              <strong>{c.patient.firstName} {c.patient.lastName}</strong>
              <span>{c.canReadMessages === false ? 'Contenido reservado a su terapeuta' : (c.messages[0]?.body || 'Sin mensajes todavía')}</span>
              <small>{STATUS_LABEL[c.status]} · {formatDateTime(c.lastActivityAt ?? c.updatedAt)}{c.unreadCount ? ` · ${c.unreadCount} sin leer` : ''}</small>
            </button>)}
            {!loadingList && !conversations.length && <div className="empty-state"><strong>No hay conversaciones</strong><p>Las conversaciones se crean desde la ficha del paciente.</p></div>}
          </aside>
          <article className="message-thread" aria-live="polite">
            {selected && metadataOnly ? <>
              <header className="thread-header"><div><h2><Link href={`/patients/${selected.patient.id}`}>{selected.patient.firstName} {selected.patient.lastName}</Link></h2><p>Solo datos de gestión de la conversación</p></div></header>
              <div className="e1-notice info" role="note"><div><strong>Solo su terapeuta puede leer los mensajes</strong><p>Puedes ver que la conversación existe, su estado y su última actividad, pero no su contenido.</p></div></div>
              <dl className="e1-meta">
                <div><dt>Profesional</dt><dd>{professional?.patientId === selected.patient.id ? professional.name : 'Cargando…'}</dd></div>
                <div><dt>Estado</dt><dd>{STATUS_LABEL[selected.status]}</dd></div>
                <div><dt>Última actividad</dt><dd>{formatDateTime(selected.lastActivityAt ?? selected.updatedAt)}</dd></div>
              </dl>
              {viewer?.isClinician && <div className="e1-actions"><p className="muted" style={{ margin: 0 }}>¿Atendiste antes a este paciente? Puedes consultar los mensajes de tu tratamiento, en solo lectura.</p><button type="button" className="button secondary" onClick={openOwnHistory}>Ver mis mensajes anteriores</button></div>}
            </> : !thread ? <div className="empty-state"><strong>{loadingThread ? 'Cargando conversación…' : 'Selecciona una conversación'}</strong>{!loadingThread && <p>Aquí verás el historial completo.</p>}</div> : <>
              <header className="thread-header"><div><h2><Link href={`/patients/${thread.patient.id}`}>{thread.patient.firstName} {thread.patient.lastName}</Link></h2><p>{thread.status === 'OPEN' ? 'Conversación abierta' : 'Conversación cerrada'} · {thread.patientCanReply ? 'El paciente puede responder' : 'Respuestas del paciente bloqueadas'}</p></div>{!readOnly && <div className="thread-actions">
                <button className="button secondary" disabled={busy} onClick={() => updateConversation({ patientCanReply: !thread.patientCanReply })}>{thread.patientCanReply ? 'Bloquear respuestas' : 'Permitir respuestas'}</button>
                <button className="button secondary" disabled={busy} onClick={() => updateConversation({ status: thread.status === 'OPEN' ? 'CLOSED' : 'OPEN' })}>{thread.status === 'OPEN' ? 'Cerrar conversación' : 'Reabrir conversación'}</button>
                <button className="button secondary" disabled={busy} onClick={() => { if (window.confirm('La conversación dejará de aparecer en la bandeja, pero conservará su historial. ¿Archivar?')) updateConversation({ status: 'ARCHIVED' }).then(() => { setThread(null); setSelectedId(''); loadList(search); }); }}>Archivar</button>
              </div>}</header>
              {readOnly && <div className="e1-notice" role="note"><div><strong>Solo lectura</strong><p>Tu proceso con este paciente ya no está activo: ves los mensajes de cuando le atendías, pero no puedes escribir ni gestionar la conversación.</p></div></div>}
              <div className="urgent-boundary"><strong>Importante:</strong> este canal no sustituye la atención urgente. Ante una emergencia, utiliza los recursos asistenciales correspondientes.</div>
              <div className="message-stream">{thread.messages.map(m => <div key={m.id} className={`message-bubble ${m.senderType === 'PROFESSIONAL' ? 'professional' : 'patient'}`}><span>{m.senderType === 'PROFESSIONAL' ? 'Profesional' : 'Paciente'}</span><p>{m.body}</p><small>{new Date(m.createdAt).toLocaleString('es-ES')}</small></div>)}{!thread.messages.length && <p className="muted">Todavía no hay mensajes.</p>}</div>
              {!readOnly && <form className="message-composer" onSubmit={send}><label className="field">Nuevo mensaje<textarea name="body" maxLength={4000} rows={4} placeholder="Escribe una indicación breve y clara…" disabled={thread.status !== 'OPEN'} required /></label><div><small>No incluyas información innecesaria en notificaciones externas.</small><button className="button primary" disabled={busy || thread.status !== 'OPEN'}>{busy ? 'Enviando…' : 'Enviar mensaje'}</button></div></form>}
            </>}
          </article>
        </section>
      </main>
    </div>
  );
}
