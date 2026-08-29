'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Sidebar from '../../components/Sidebar';
import { api } from '@/lib/api';

type ResourceType = 'LINK' | 'FILE';

type ResourceCategory =
  | 'PSYCHOEDUCATION'
  | 'EXERCISE'
  | 'WORKSHEET'
  | 'AUDIO'
  | 'VIDEO'
  | 'READING'
  | 'OTHER';

type Resource = {
  id: string;
  title: string;
  description?: string | null;
  type: ResourceType;
  category: ResourceCategory;
  url?: string | null;
  archivedAt?: string | null;
  _count?: { shares: number };
};

type Patient = {
  id: string;
  firstName: string;
  lastName: string;
};

type Page<T> = {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};

const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  PSYCHOEDUCATION: 'Psicoeducación',
  EXERCISE: 'Ejercicio',
  WORKSHEET: 'Hoja de trabajo',
  AUDIO: 'Audio',
  VIDEO: 'Vídeo',
  READING: 'Lectura',
  OTHER: 'Otro',
};

const CATEGORY_OPTIONS = Object.keys(CATEGORY_LABELS) as ResourceCategory[];

export default function LibraryPage() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [search, setSearch] = useState('');
  const [newResourceOpen, setNewResourceOpen] = useState(false);
  const [sharingId, setSharingId] = useState<string>('');
  const [sharePatientId, setSharePatientId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [resourceType, setResourceType] = useState<ResourceType>('LINK');

  async function loadResources(q = '') {
    try {
      setLoading(true);
      setError('');
      const rows = await api<Resource[]>(`/resources${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      setResources(rows);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar los recursos.');
    } finally {
      setLoading(false);
    }
  }

  async function loadPatients() {
    try {
      const page = await api<Page<Patient>>('/patients?status=ACTIVE&pageSize=100');
      setPatients(page.data);
    } catch {
      // La biblioteca sigue siendo útil aunque falle esto; no bloqueamos la pantalla por ello.
    }
  }

  useEffect(() => {
    void loadResources();
    void loadPatients();
  }, []);

  const groupedResources = useMemo(() => {
    const groups = new Map<ResourceCategory, Resource[]>();
    for (const resource of resources) {
      const list = groups.get(resource.category) ?? [];
      list.push(resource);
      groups.set(resource.category, list);
    }
    return Array.from(groups.entries());
  }, [resources]);

  function closeNewResourceForm() {
    setNewResourceOpen(false);
    setResourceType('LINK');
    setError('');
    setSuccessMessage('');
  }

  async function createResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    const title = String(formData.get('title') || '').trim();
    const description = String(formData.get('description') || '').trim();
    const category = String(formData.get('category') || 'OTHER') as ResourceCategory;
    const url = String(formData.get('url') || '').trim();

    if (!title) {
      setError('Ponle un título al recurso.');
      return;
    }
    if (!url) {
      setError('Añade el enlace del recurso.');
      return;
    }

    try {
      setSaving(true);
      setError('');
      setSuccessMessage('');
      await api('/resources', {
        method: 'POST',
        body: JSON.stringify({ title, description: description || undefined, type: 'LINK', category, url }),
      });
      form.reset();
      closeNewResourceForm();
      setSuccessMessage('El recurso se ha añadido a la biblioteca.');
      await loadResources(search);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'No se pudo crear el recurso.');
    } finally {
      setSaving(false);
    }
  }

  async function archiveResource(id: string) {
    if (!window.confirm('El recurso dejará de estar disponible para compartir. ¿Archivarlo?')) return;
    try {
      setError('');
      await api(`/resources/${id}`, { method: 'DELETE' });
      await loadResources(search);
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : 'No se pudo archivar el recurso.');
    }
  }

  function openShare(resourceId: string) {
    setSharingId(resourceId);
    setSharePatientId('');
    setError('');
    setSuccessMessage('');
  }

  async function confirmShare(resourceId: string) {
    if (!sharePatientId) {
      setError('Selecciona a qué paciente se lo compartes.');
      return;
    }
    try {
      setSaving(true);
      setError('');
      await api(`/patients/${sharePatientId}/resources/${resourceId}/share`, { method: 'POST' });
      setSuccessMessage('Recurso compartido con el paciente.');
      setSharingId('');
      await loadResources(search);
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'No se pudo compartir el recurso.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app-layout">
      <Sidebar syncText="Biblioteca conectada con el seguimiento del paciente" />

      <main className="dashboard">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">BIBLIOTECA</p>
            <h1>Recursos para tus pacientes</h1>
            <p className="dashboard-subtitle">
              Psicoeducación, ejercicios y material de apoyo que puedes compartir directamente con el portal de cada paciente.
            </p>
          </div>

          <div className="dashboard-actions">
            <button
              type="button"
              className="primary-action"
              onClick={() => {
                setError('');
                setSuccessMessage('');
                setNewResourceOpen(true);
              }}
            >
              + Nuevo recurso
            </button>
          </div>
        </header>

        {error && (
          <div className="dashboard-card agenda-error" role="alert">
            {error}
          </div>
        )}

        {successMessage && (
          <div
            className="dashboard-card"
            role="status"
            style={{
              padding: '16px',
              marginBottom: '20px',
              border: '1px solid rgba(0, 120, 90, 0.2)',
              background: 'rgba(0, 120, 90, 0.08)',
              color: '#075c47',
            }}
          >
            {successMessage}
          </div>
        )}

        {newResourceOpen && (
          <section className="dashboard-card agenda-form-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">NUEVO RECURSO</p>
                <h2>Añadir a la biblioteca</h2>
              </div>
              <button type="button" className="small-secondary" onClick={closeNewResourceForm}>
                Cerrar
              </button>
            </div>

            <form className="agenda-form" onSubmit={createResource}>
              <label>
                <span>Título</span>
                <input name="title" type="text" required maxLength={180} placeholder="Ej. Ejercicio de respiración 4-7-8" />
              </label>

              <label>
                <span>Categoría</span>
                <select name="category" defaultValue="PSYCHOEDUCATION">
                  {CATEGORY_OPTIONS.map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Tipo</span>
                <select
                  name="type"
                  value={resourceType}
                  onChange={(event) => setResourceType(event.target.value as ResourceType)}
                >
                  <option value="LINK">Enlace</option>
                  <option value="FILE" disabled>
                    Archivo (próximamente)
                  </option>
                </select>
              </label>

              {resourceType === 'LINK' && (
                <label>
                  <span>Enlace</span>
                  <input name="url" type="url" required placeholder="https://..." />
                </label>
              )}

              <label className="agenda-form-notes">
                <span>Descripción</span>
                <textarea name="description" rows={3} maxLength={2000} placeholder="Para qué sirve este recurso y cuándo dárselo a un paciente..." />
              </label>

              <div className="agenda-form-actions">
                <button type="button" className="small-secondary" onClick={closeNewResourceForm}>
                  Cancelar
                </button>
                <button type="submit" className="primary-action" disabled={saving}>
                  {saving ? 'Guardando...' : 'Guardar recurso'}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="dashboard-card">
          <label className="field">
            Buscar recurso
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                void loadResources(event.target.value);
              }}
              placeholder="Título del recurso"
            />
          </label>
        </section>

        {loading ? (
          <p className="agenda-empty">Cargando biblioteca...</p>
        ) : resources.length === 0 ? (
          <div className="dashboard-card empty-state">
            <strong>Todavía no hay recursos</strong>
            <p>Añade el primero con el botón &quot;+ Nuevo recurso&quot; de arriba.</p>
          </div>
        ) : (
          groupedResources.map(([category, items]) => (
            <section className="dashboard-card" key={category} style={{ marginBottom: '16px' }}>
              <h2>{CATEGORY_LABELS[category]}</h2>
              <div className="stack">
                {items.map((resource) => (
                  <article
                    key={resource.id}
                    className="agenda-session"
                    style={{ display: 'block', marginBottom: '12px' }}
                  >
                    <div className="agenda-session-patient">
                      <div>
                        <strong>{resource.title}</strong>
                        {resource.description && <p className="agenda-session-notes">{resource.description}</p>}
                        {resource.url && (
                          <p className="agenda-session-notes">
                            <a href={resource.url} target="_blank" rel="noreferrer">
                              Abrir enlace
                            </a>
                          </p>
                        )}
                        <small>
                          Compartido activamente con {resource._count?.shares ?? 0}{' '}
                          {resource._count?.shares === 1 ? 'paciente' : 'pacientes'}
                        </small>
                      </div>
                    </div>

                    {sharingId === resource.id ? (
                      <div className="agenda-form-actions" style={{ marginTop: '12px' }}>
                        <select
                          value={sharePatientId}
                          onChange={(event) => setSharePatientId(event.target.value)}
                        >
                          <option value="" disabled>
                            Selecciona un paciente
                          </option>
                          {patients.map((patient) => (
                            <option key={patient.id} value={patient.id}>
                              {patient.firstName} {patient.lastName}
                            </option>
                          ))}
                        </select>
                        <button type="button" className="small-secondary" onClick={() => setSharingId('')}>
                          Cancelar
                        </button>
                        <button
                          type="button"
                          className="primary-action"
                          disabled={saving}
                          onClick={() => confirmShare(resource.id)}
                        >
                          Compartir
                        </button>
                      </div>
                    ) : (
                      <div className="agenda-session-actions">
                        <button type="button" onClick={() => openShare(resource.id)}>
                          Compartir con paciente
                        </button>
                        <button type="button" onClick={() => archiveResource(resource.id)}>
                          Archivar
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))
        )}
      </main>
    </div>
  );
}
