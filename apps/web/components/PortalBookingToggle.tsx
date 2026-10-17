'use client';

type Props = {
  /** Quien edita puede activarla (el propio profesional, titular o administración). */
  canToggle: boolean;
  /** Se está editando la disponibilidad propia. */
  isSelf: boolean;
  professionalName?: string;
  enabled: boolean;
  /** Hay al menos una franja definida. */
  hasWindows: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
};

/**
 * Interruptor "Permitir que mis pacientes pidan cita desde su portal". Desactivado por defecto.
 * Recepción (sin permiso) no ve ningún interruptor, solo el estado en texto.
 */
export default function PortalBookingToggle({ canToggle, isSelf, professionalName, enabled, hasWindows, busy, onToggle }: Props) {
  return (
    <section className="dashboard-card bk-section" aria-labelledby="bk-toggle-title">
      <h2 id="bk-toggle-title">Reserva desde el portal</h2>
      {canToggle ? (
        <>
          <label className="e1-switch bk-switch" htmlFor="bk-portal-toggle">
            <input
              id="bk-portal-toggle"
              type="checkbox"
              role="switch"
              checked={enabled}
              aria-checked={enabled}
              aria-describedby="bk-toggle-hint"
              disabled={busy}
              onChange={(event) => onToggle(event.target.checked)}
            />
            {isSelf
              ? 'Permitir que mis pacientes pidan cita desde su portal'
              : `Permitir que los pacientes de ${professionalName ?? 'este profesional'} pidan cita desde su portal`}
          </label>
          <p id="bk-toggle-hint" className="bk-hint">Viene desactivado. Cada petición llega a Solicitudes de cita y se acepta o se rechaza a mano.</p>
        </>
      ) : (
        <p className="bk-hint">
          La reserva desde el portal está <strong>{enabled ? 'activada' : 'desactivada'}</strong>.
          Solo el propio profesional, la persona titular o administración pueden cambiarlo.
        </p>
      )}
      {enabled && !hasWindows && (
        <p className="e1-notice info bk-warn" role="note">Todavía no hay franjas definidas, así que los pacientes no verán horas libres.</p>
      )}
    </section>
  );
}
