'use client';

import { useState } from 'react';
import type { StaffAppointmentRequestContract } from '@asepsico/contracts';
import { longDateTimeLabel, personName, REJECTION_REASON_LABEL, STAFF_STATUS_LABEL, STAFF_TYPE_LABEL, STATUS_TONE, timeLabel } from '@/lib/booking';

type Props = {
  request: StaffAppointmentRequestContract;
  /** Enseña el profesional (para recepción, titular y administración, que ven varios). */
  showTherapist: boolean;
  busy: boolean;
  onApprove: (request: StaffAppointmentRequestContract) => void;
  onReject: (request: StaffAppointmentRequestContract) => void;
};

const APPROVE_LABEL = { NEW: 'Aceptar cita', RESCHEDULE: 'Aceptar el cambio', CANCEL: 'Aceptar la cancelación' } as const;

/**
 * Una solicitud de cita en la bandeja. Vista administrativa: nombre, profesional, tipo y hueco.
 * Nunca motivo de consulta, proceso ni notas.
 */
export default function RequestCard({ request, showTherapist, busy, onApprove, onReject }: Props) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const pending = request.status === 'PENDING';
  const slot = request.startsAt && request.endsAt
    ? `${longDateTimeLabel(request.startsAt)} – ${timeLabel(request.endsAt)}`
    : null;
  const current = request.session ? longDateTimeLabel(request.session.startsAt) : null;

  return (
    <li className="bk-req">
      <div className="bk-req-head">
        <div className="bk-chips">
          <span className={`ui-chip ${STATUS_TONE[request.status]}`}>{STAFF_STATUS_LABEL[request.status]}</span>
          <span className="ui-chip chip-violet">{STAFF_TYPE_LABEL[request.type]}</span>
          {request.accessorType === 'GUARDIAN' && <span className="ui-chip chip-blue">Pedida por su tutor/a</span>}
        </div>
        <strong className="bk-req-patient">{personName(request.patient)}</strong>
        {showTherapist && <span className="bk-req-meta">Con {personName(request.therapist)}</span>}
      </div>

      <dl className="bk-req-slots">
        {request.type === 'NEW' && slot && <div><dt>Hora pedida</dt><dd>{slot}</dd></div>}
        {request.type === 'RESCHEDULE' && (
          <>
            {current && <div><dt>Cita actual</dt><dd>{current}</dd></div>}
            {slot && <div><dt>Nueva hora pedida</dt><dd>{slot}</dd></div>}
          </>
        )}
        {request.type === 'CANCEL' && current && <div><dt>Cita que quiere cancelar</dt><dd>{current}</dd></div>}
        {pending && <div><dt>Caduca</dt><dd>{longDateTimeLabel(request.expiresAt)}</dd></div>}
        {request.status === 'REJECTED' && request.rejectionReason && <div><dt>Motivo</dt><dd>{REJECTION_REASON_LABEL[request.rejectionReason]}</dd></div>}
      </dl>

      {pending && (
        confirmingCancel ? (
          <div className="bk-inline-confirm" role="group" aria-label="Confirmar la cancelación de la cita">
            <span>La cita se cancelará. ¿Seguro?</span>
            <button type="button" className="button" disabled={busy} onClick={() => { setConfirmingCancel(false); onApprove(request); }}>Sí, cancelar la cita</button>
            <button type="button" className="bk-link-button" onClick={() => setConfirmingCancel(false)}>Volver</button>
          </div>
        ) : (
          <div className="bk-actions">
            <button type="button" className="button" disabled={busy} onClick={() => (request.type === 'CANCEL' ? setConfirmingCancel(true) : onApprove(request))}>
              {APPROVE_LABEL[request.type]}
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => onReject(request)}>Rechazar</button>
          </div>
        )
      )}
    </li>
  );
}
