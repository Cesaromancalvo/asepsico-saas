"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { api } from "@/lib/api";
import { isForbidden, modalityLabel, processLabel, sessionClinicalAccess, useViewer } from "@/lib/clinical";

type Session = {
  id: string;
  therapistId?: string | null;
  startsAt: string;
  endsAt: string;
  status?: string | null;
  type?: string | null;
  location?: string | null;
  videoCallUrl?: string | null;
  // Solo llegan si la API concede acceso clínico (ver sessionClinicalAccess).
  notes?: string | null;
  internalSummary?: string | null;
  patient?: { id: string; firstName?: string | null; lastName?: string | null; email?: string | null } | null;
  therapist?: { id: string; firstName?: string | null; lastName?: string | null; email?: string | null } | null;
  clinicalProcess?: { id: string; title?: string | null; status?: string | null; modality?: string | null } | null;
};

const SESSION_STATUS: Record<string, string> = { SCHEDULED: "Programada", COMPLETED: "Completada", CANCELLED: "Cancelada", NO_SHOW: "No asistió" };
const SESSION_TYPE: Record<string, string> = { INDIVIDUAL: "Individual", COUPLE: "Pareja", FAMILY: "Familiar", GROUP: "Grupal", FOLLOW_UP: "Seguimiento", ASSESSMENT: "Evaluación" };

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-ES", { dateStyle: "full", timeStyle: "short" }).format(new Date(value));
}

function fullName(person?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null) {
  if (!person) return "No disponible";
  return [person.firstName, person.lastName].filter(Boolean).join(" ").trim() || person.email || "No disponible";
}

export default function SessionDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params?.sessionId;
  const viewer = useViewer();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [status, setStatus] = useState("");

  async function loadSession() {
    if (!sessionId) return;
    try {
      setLoading(true);
      setError("");
      setForbidden(false);
      setSession(await api<Session>(`/sessions/${sessionId}`));
    } catch (err) {
      if (isForbidden(err)) setForbidden(true);
      else setError(err instanceof Error ? err.message : "No se pudo cargar la sesión.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSession();
  }, [sessionId]);

  const access = session ? sessionClinicalAccess(session, viewer) : null;

  async function saveSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionId || !access || access.readOnly) return;
    const data = new FormData(event.currentTarget);
    try {
      setSaving(true);
      setError("");
      setStatus("");
      const updated = await api<Session>(`/sessions/${sessionId}/notes`, {
        method: "PATCH",
        body: JSON.stringify({ notes: String(data.get("notes") ?? ""), internalSummary: String(data.get("internalSummary") ?? "") }),
      });
      setSession((current) => (current ? { ...current, ...updated } : updated));
      setStatus("Sesión guardada.");
    } catch (err) {
      setError(isForbidden(err)
        ? "No puedes modificar las notas de esta sesión: solo su profesional, con el proceso activo."
        : err instanceof Error ? err.message : "No se pudieron guardar los cambios.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="app-layout"><Sidebar /><main className="patient-record-page"><div className="patient-record-loading" role="status">Cargando sesión…</div></main></div>;
  }

  if (!session) {
    return (
      <div className="app-layout"><Sidebar /><main className="patient-record-page">
        <Link href="/agenda" className="patient-record-back">← Volver a la agenda</Link>
        {forbidden ? (
          <div className="e1-notice info" role="note"><div><strong>Sesión de otro profesional</strong><p>No tienes acceso a esta sesión.</p></div></div>
        ) : (
          <>
            <div className="agenda-error" role="alert">{error || "No se ha encontrado la sesión."}</div>
            <button type="button" className="button secondary" onClick={loadSession}>Reintentar</button>
          </>
        )}
      </main></div>
    );
  }

  const processStatus = session.clinicalProcess?.status ?? null;

  return (
    <div className="app-layout"><Sidebar /><main className="patient-record-page e1-session-page">
      <header className="patient-record-header">
        <div>
          <Link href="/agenda" className="patient-record-back">← Volver a la agenda</Link>
          <div className="patient-record-kicker">Ficha de sesión</div>
          <h1>{fullName(session.patient)}</h1>
          <p className="muted">{formatDateTime(session.startsAt)}</p>
        </div>
        {session.patient && <Link href={`/patients/${session.patient.id}`} className="button secondary">Abrir ficha del paciente</Link>}
      </header>

      {error && <div className="agenda-error" role="alert">{error}</div>}
      <p className={status ? "patient-save-state" : undefined} role="status" aria-live="polite">{status}</p>

      <div className="e1-stack">
        <section className="patient-record-card">
          <h2>Información de la sesión</h2>
          <dl className="e1-meta">
            <div><dt>Inicio</dt><dd>{formatDateTime(session.startsAt)}</dd></div>
            <div><dt>Fin</dt><dd>{formatDateTime(session.endsAt)}</dd></div>
            <div><dt>Estado</dt><dd>{session.status ? SESSION_STATUS[session.status] ?? session.status : "No indicado"}</dd></div>
            <div><dt>Tipo</dt><dd>{session.type ? SESSION_TYPE[session.type] ?? session.type : "No indicado"}</dd></div>
            <div><dt>Ubicación</dt><dd>{session.location || "No indicada"}</dd></div>
            <div><dt>Profesional</dt><dd>{fullName(session.therapist)}</dd></div>
            <div><dt>Proceso</dt><dd>{session.clinicalProcess ? processLabel(session.clinicalProcess) : "Sin proceso"}</dd></div>
            <div><dt>Modalidad</dt><dd>{modalityLabel(session.clinicalProcess?.modality) ?? "No indicada"}</dd></div>
          </dl>
          <div className="e1-actions">
            {session.videoCallUrl && <a href={session.videoCallUrl} target="_blank" rel="noreferrer noopener" className="button">Abrir videollamada</a>}
            {session.patient && session.clinicalProcess && (
              <Link href={`/patients/${session.patient.id}/processes/${session.clinicalProcess.id}`} className="button secondary">Ver proceso</Link>
            )}
          </div>
        </section>

        {access && !access.canRead && (
          <div className="e1-notice info" role="note">
            <div><strong>Notas reservadas</strong><p>Solo el profesional que atiende a este paciente puede ver las notas de la sesión.</p></div>
          </div>
        )}

        {access && access.canRead && access.readOnly && (
          <div className="e1-notice" role="note">
            <div>
              <strong>Solo lectura</strong>
              <p>
                {!access.isAuthor
                  ? "Esta sesión es de otro profesional: puedes consultar sus notas, pero solo su autor las modifica."
                  : processStatus === "PAUSED"
                    ? "El proceso está en pausa. Reactívalo desde la ficha del proceso para volver a registrar notas."
                    : "El proceso ya no está activo. Conservas la lectura de lo que registraste."}
              </p>
            </div>
            {access.isAuthor && access.processInactive && session.patient && session.clinicalProcess && (processStatus === "PAUSED" || processStatus === "DISCHARGED") && (
              <div className="e1-notice-actions">
                <Link href={`/patients/${session.patient.id}/processes/${session.clinicalProcess.id}`} className="button">Ir al proceso para reactivarlo</Link>
              </div>
            )}
          </div>
        )}

        {access && access.canRead && (access.readOnly ? (
          <section className="patient-record-card" aria-label="Registro clínico (solo lectura)">
            <h2>Registro clínico</h2>
            <h3>Notas de la sesión</h3>
            <p className="e1-readonly-text">{session.notes || "Sin notas"}</p>
            {access.isAuthor && <><h3>Resumen interno</h3><p className="e1-readonly-text">{session.internalSummary || "Sin resumen"}</p></>}
          </section>
        ) : (
          <form className="patient-record-card e1-form" style={{ maxWidth: "none" }} onSubmit={saveSession}>
            <h2>Registro clínico</h2>
            <label className="field">Notas de la sesión
              <textarea key={`notes-${session.id}`} name="notes" defaultValue={session.notes ?? ""} rows={7} placeholder="Escribe aquí las notas de la sesión…" />
            </label>
            <label className="field">Resumen interno (solo tú)
              <textarea key={`summary-${session.id}`} name="internalSummary" defaultValue={session.internalSummary ?? ""} rows={5} placeholder="Resumen interno para seguimiento clínico…" />
            </label>
            <div className="e1-actions"><button type="submit" className="button" disabled={saving}>{saving ? "Guardando…" : "Guardar cambios"}</button></div>
          </form>
        ))}
      </div>
    </main></div>
  );
}
