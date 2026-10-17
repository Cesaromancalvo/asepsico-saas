'use client';

import { useEffect, useState } from 'react';
import type { PatientAccessHistoryResponse } from '@asepsico/contracts';
import { api } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/clinical';
import { durationText, exceptionalReasonLabel, formatDateTime, openingReasonLabel, untilText } from '@/lib/exceptional-access';

type Row = { key: string; date: string; who: string; role: string; what: string; reason: string; detail: string };

/** Une accesos y aperturas en una sola lista por fecha. Nunca hay texto de explicación. */
export function accessHistoryRows(data: PatientAccessHistoryResponse, now: Date = new Date()): Row[] {
  const name = (value: string | null) => value || 'Un miembro de la consulta';
  const rows: Row[] = [
    ...data.accesses.map((row) => ({
      key: `a-${row.id}`,
      date: row.createdAt,
      who: name(row.actorName),
      role: ROLE_LABEL[row.actorRole] ?? row.actorRole,
      what: 'Acceso excepcional',
      reason: exceptionalReasonLabel(row.reasonCode),
      // Un acceso aún abierto no tiene duración final: se dice hasta cuándo vale.
      detail: !row.closedAt && new Date(row.expiresAt).getTime() > now.getTime()
        ? `Vigente ${untilText(row.expiresAt, now)}`
        : `Duración: ${durationText(row.createdAt, row.endedAt)}`,
    })),
    ...data.openings.map((row) => ({
      key: `o-${row.id}`,
      date: row.createdAt,
      who: name(row.actorName),
      role: ROLE_LABEL[row.actorRole] ?? row.actorRole,
      what: row.kind === 'REACTIVATED' ? 'Reactivación de proceso' : 'Apertura de proceso',
      reason: openingReasonLabel(row.reasonCode),
      detail: '',
    })),
  ];
  return rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/**
 * "Accesos de otras personas" (CA3.2): solo para los profesionales autores de algún proceso del
 * paciente (la ficha no lo pide a nadie más, para no generar denegaciones auditadas).
 */
export default function PatientAccessHistory({ patientId }: { patientId: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api<PatientAccessHistoryResponse>(`/patients/${patientId}/access-history`)
      .then((data) => { if (!cancelled) { setRows(accessHistoryRows(data)); setState('ready'); } })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [patientId]);

  return (
    <section className="patient-record-card patient-unified-main-card xa-history" aria-labelledby="xa-history-heading">
      <div className="patient-unified-card-heading"><div><span>Trazabilidad</span><h2 id="xa-history-heading">Accesos de otras personas</h2></div></div>
      <p className="muted">Quién ha abierto la historia de este paciente sin atenderle, o le ha abierto un proceso, y por qué motivo.</p>
      {state === 'loading' && <p className="muted" role="status">Cargando accesos…</p>}
      {state === 'error' && <p className="agenda-error" role="alert">No se pudieron cargar los accesos. Vuelve a intentarlo en unos minutos.</p>}
      {state === 'ready' && rows.length === 0 && <p className="xa-empty">Nadie más ha accedido a la historia de este paciente.</p>}
      {state === 'ready' && rows.length > 0 && (
        <ul className="e1-list">
          {rows.map((row) => (
            <li key={row.key} className="e1-row xa-row">
              <div><strong>{row.what}</strong><small>{formatDateTime(row.date)}</small></div>
              <div><span>{row.who} <small>({row.role})</small></span><small>{row.reason}</small></div>
              <div>{row.detail && <small>{row.detail}</small>}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
