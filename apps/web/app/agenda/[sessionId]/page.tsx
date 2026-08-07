"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

type Session = {
  id: string;
  startsAt: string;
  endsAt: string;
  type?: string | null;
  location?: string | null;
  videoCallUrl?: string | null;
  notes?: string | null;
  internalSummary?: string | null;
  patient?: {
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
  } | null;
  therapist?: {
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
  } | null;
  clinicalProcess?: {
    id: string;
    status?: string | null;
    modality?: string | null;
  } | null;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(value));
}

function getFullName(
  person:
    | {
        firstName?: string | null;
        lastName?: string | null;
        email?: string | null;
      }
    | null
    | undefined,
) {
  if (!person) return "No disponible";

  const fullName = [person.firstName, person.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || person.email || "No disponible";
}

export default function SessionDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();

  const [session, setSession] = useState<Session | null>(null);
  const [notes, setNotes] = useState("");
  const [internalSummary, setInternalSummary] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const sessionId = params?.sessionId;

  useEffect(() => {
    if (!sessionId) return;

    async function loadSession() {
      try {
        setLoading(true);
        setError("");

        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/sessions/${sessionId}`,
          {
            credentials: "include",
          },
        );

        if (!response.ok) {
          const body = await response.json().catch(() => null);

          throw new Error(
            body?.message ?? "No se pudo cargar la sesión.",
          );
        }

        const data: Session = await response.json();

        setSession(data);
        setNotes(data.notes ?? "");
        setInternalSummary(data.internalSummary ?? "");
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Se ha producido un error inesperado.",
        );
      } finally {
        setLoading(false);
      }
    }

    void loadSession();
  }, [sessionId]);

  async function saveSession() {
    if (!sessionId) return;

    try {
      setSaving(true);
      setError("");

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/sessions/${sessionId}/notes`,
        {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            notes,
            internalSummary,
          }),
        },
      );

      if (!response.ok) {
        const body = await response.json().catch(() => null);

        throw new Error(
          body?.message ?? "No se pudieron guardar los cambios.",
        );
      }

      const updatedSession: Session = await response.json();

      setSession(updatedSession);
      setNotes(updatedSession.notes ?? "");
      setInternalSummary(updatedSession.internalSummary ?? "");

      alert("Sesión guardada correctamente.");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Se ha producido un error inesperado.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="p-8">
        <p>Cargando sesión...</p>
      </main>
    );
  }

  if (error && !session) {
    return (
      <main className="p-8">
        <button
          type="button"
          onClick={() => router.push("/agenda")}
          className="mb-6 rounded-lg border px-4 py-2"
        >
          Volver a la agenda
        </button>

        <p className="text-red-600">{error}</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="p-8">
        <p>No se ha encontrado la sesión.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <button
        type="button"
        onClick={() => router.push("/agenda")}
        className="mb-6 rounded-lg border px-4 py-2 hover:bg-gray-50"
      >
        ← Volver a la agenda
      </button>

      <div className="mb-8">
        <p className="text-sm text-gray-500">Ficha de sesión</p>

        <h1 className="text-3xl font-semibold">
          {getFullName(session.patient)}
        </h1>

        <p className="mt-2 text-gray-600">
          {formatDateTime(session.startsAt)}
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 p-4 text-red-700">
          {error}
        </div>
      )}

      <section className="grid gap-6 md:grid-cols-2">
        <article className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">
            Información de la sesión
          </h2>

          <div className="space-y-3 text-sm">
            <p>
              <strong>Inicio:</strong>{" "}
              {formatDateTime(session.startsAt)}
            </p>

            <p>
              <strong>Finalización:</strong>{" "}
              {formatDateTime(session.endsAt)}
            </p>

            <p>
              <strong>Tipo:</strong> {session.type ?? "No indicado"}
            </p>

            <p>
              <strong>Ubicación:</strong>{" "}
              {session.location ?? "No indicada"}
            </p>

            <p>
              <strong>Terapeuta:</strong>{" "}
              {getFullName(session.therapist)}
            </p>

            <p>
              <strong>Modalidad:</strong>{" "}
              {session.clinicalProcess?.modality ?? "No indicada"}
            </p>

            <p>
              <strong>Estado del proceso:</strong>{" "}
              {session.clinicalProcess?.status ?? "No indicado"}
            </p>
          </div>

          {session.videoCallUrl && (
            <a
              href={session.videoCallUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-block rounded-lg bg-black px-4 py-2 text-white"
            >
              Abrir videollamada
            </a>
          )}
        </article>

        <article className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">
            Datos del paciente
          </h2>

          <div className="space-y-3 text-sm">
            <p>
              <strong>Nombre:</strong>{" "}
              {getFullName(session.patient)}
            </p>

            <p>
              <strong>Email:</strong>{" "}
              {session.patient?.email ?? "No disponible"}
            </p>

            <p>
              <strong>Proceso clínico:</strong>{" "}
              {session.clinicalProcess?.id ?? "No disponible"}
            </p>
          </div>
        </article>
      </section>

      <section className="mt-6 rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold">
          Registro clínico
        </h2>

        <div className="space-y-6">
          <div>
            <label
              htmlFor="notes"
              className="mb-2 block text-sm font-medium"
            >
              Notas de la sesión
            </label>

            <textarea
              id="notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={7}
              className="w-full rounded-lg border p-3"
              placeholder="Escribe aquí las notas de la sesión..."
            />
          </div>

          <div>
            <label
              htmlFor="internalSummary"
              className="mb-2 block text-sm font-medium"
            >
              Resumen interno
            </label>

            <textarea
              id="internalSummary"
              value={internalSummary}
              onChange={(event) =>
                setInternalSummary(event.target.value)
              }
              rows={5}
              className="w-full rounded-lg border p-3"
              placeholder="Resumen interno para seguimiento clínico..."
            />
          </div>

          <button
            type="button"
            onClick={saveSession}
            disabled={saving}
            className="rounded-lg bg-black px-5 py-3 text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Guardando..." : "Guardar cambios"}
          </button>
        </div>
      </section>
    </main>
  );
}
