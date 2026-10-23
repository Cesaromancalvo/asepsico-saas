'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { exceptionalReasonLabel, minutesLeft, remainingText, untilText } from '@/lib/exceptional-access';

type Props = {
  patientId: string;
  access: { id: string; reasonCode: string; expiresAt: string };
  /** Se ha cerrado (botón) o ha vencido: la ficha vuelve a preguntar a la API. */
  onEnded: () => void;
};

/**
 * Banda fija de la ficha mientras dura el acceso (§3.4): "Acceso excepcional · motivo · hasta
 * las HH:MM · [Cerrar acceso]". La caducidad real la decide la API en cada petición; aquí solo se
 * avisa y, al llegar la hora, se vuelve a preguntar.
 */
export default function ExceptionalAccessBanner({ patientId, access, onEnded }: Props) {
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const left = minutesLeft(access.expiresAt, now);
  useEffect(() => {
    if (left <= 0) onEnded();
  }, [left, onEnded]);

  async function close() {
    setBusy(true);
    setError('');
    try {
      await api(`/patients/${patientId}/exceptional-access/${access.id}/close`, { method: 'POST' });
      onEnded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cerrar el acceso');
      setBusy(false);
    }
  }

  const label = exceptionalReasonLabel(access.reasonCode);
  return (
    <section className="xa-banner" aria-label="Acceso excepcional vigente">
      <div className="xa-banner-text">
        <strong>Acceso excepcional</strong>
        <span aria-hidden="true">·</span>
        <span>{label}</span>
        <span aria-hidden="true">·</span>
        <span>{untilText(access.expiresAt, now)} <small>({remainingText(access.expiresAt, now)})</small></span>
        <p>Solo lectura. No incluye las notas internas de los profesionales. Se cierra también al cerrar sesión.</p>
        {error && <p className="xa-banner-error" role="alert">{error}</p>}
      </div>
      <button type="button" className="button secondary" disabled={busy} onClick={close}>{busy ? 'Cerrando…' : 'Cerrar acceso'}</button>
    </section>
  );
}
