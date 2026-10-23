'use client';

import { useState } from 'react';
import { ageInYears, formatDateTime, formatDay, SignupRequest } from '@/lib/portal-signup';

/** Etiqueta neutra para solicitudes cuyo profesional ya no está en la consulta. */
export const PROFESSIONAL_REMOVED_LABEL = 'Profesional ya no está en la consulta';

type Props = {
  request: SignupRequest;
  /** Nombre del profesional destinatario (null si no se muestra, p. ej. el propio terapeuta). */
  professionalName: string | null;
  selected: boolean;
  busy: boolean;
  onToggle: (request: SignupRequest, selected: boolean) => void;
  onCreate: (request: SignupRequest) => void;
  onLink: (request: SignupRequest) => void;
  onReject: (request: SignupRequest) => void;
};

/**
 * Una solicitud de alta en el portal. Solo datos administrativos que la persona escribió (nombre,
 * contacto y fecha de nacimiento): nunca nada clínico.
 */
export default function SignupRequestCard({ request, professionalName, selected, busy, onToggle, onCreate, onLink, onReject }: Props) {
  const [confirming, setConfirming] = useState<'create' | 'reject' | null>(null);
  const name = `${request.firstName} ${request.lastName}`;
  const checkboxId = `signup-select-${request.id}`;

  return (
    <li className={`bk-req ps-req${selected ? ' is-selected' : ''}`}>
      <div className="ps-req-top">
        <input
          id={checkboxId}
          type="checkbox"
          className="ps-req-check"
          checked={selected}
          disabled={busy}
          onChange={(event) => onToggle(request, event.target.checked)}
          aria-label={`Seleccionar la solicitud de ${name}`}
        />
        <div className="ps-req-body">
          <div className="bk-req-head">
            {request.professionalRemoved && <div className="bk-chips"><span className="ui-chip chip-neutral">{PROFESSIONAL_REMOVED_LABEL}</span></div>}
            <strong className="bk-req-patient">{name}</strong>
            {!request.professionalRemoved && professionalName && <span className="bk-req-meta">Para {professionalName}</span>}
          </div>

          <dl className="bk-req-slots">
            <div><dt>Correo</dt><dd className="ps-break">{request.email}</dd></div>
            <div><dt>Teléfono</dt><dd>{request.phone || 'No lo ha indicado'}</dd></div>
            <div><dt>Fecha de nacimiento</dt><dd>{formatDay(request.birthDate)} · {ageInYears(request.birthDate)} años</dd></div>
            <div><dt>Recibida</dt><dd>{formatDateTime(request.createdAt)}</dd></div>
            <div><dt>Se borra si no respondes</dt><dd>{formatDateTime(request.expiresAt)}</dd></div>
          </dl>

          {confirming === 'create' && (
            <div className="bk-inline-confirm" role="group" aria-label={`Confirmar el alta de ${name}`}>
              <span>Se creará una ficha nueva con estos datos. ¿Has comprobado su identidad en persona?</span>
              <button type="button" className="button" disabled={busy} onClick={() => { setConfirming(null); onCreate(request); }}>Sí, crear paciente</button>
              <button type="button" className="bk-link-button" onClick={() => setConfirming(null)}>Volver</button>
            </div>
          )}
          {confirming === 'reject' && (
            <div className="bk-inline-confirm" role="group" aria-label={`Confirmar el rechazo de la solicitud de ${name}`}>
              <span>La solicitud se borrará. No se avisa a la persona.</span>
              <button type="button" className="button danger" disabled={busy} onClick={() => { setConfirming(null); onReject(request); }}>Sí, rechazar</button>
              <button type="button" className="bk-link-button" onClick={() => setConfirming(null)}>Volver</button>
            </div>
          )}
          {confirming === null && (
            <div className="bk-actions">
              <button type="button" className="button" disabled={busy} onClick={() => onLink(request)}>Vincular a su ficha</button>
              <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirming('create')}>Crear paciente nuevo</button>
              <button type="button" className="bk-link-button ps-reject" disabled={busy} onClick={() => setConfirming('reject')}>Rechazar</button>
            </div>
          )}
            </div>
          </div>
    </li>
  );
}
