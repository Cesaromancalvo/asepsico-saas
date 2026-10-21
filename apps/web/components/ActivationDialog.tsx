'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import type { PortalSignupAcceptedContract } from '@asepsico/contracts';
import ActivationHandoff from './ActivationHandoff';

type Props = {
  /** null = cerrado. */
  result: PortalSignupAcceptedContract | null;
  /** Nombre de la persona (dato administrativo) para el título. */
  personName?: string;
  /** Texto de contexto bajo el título (p. ej. "Paciente nuevo creado"). */
  context?: string;
  onClose: () => void;
};

/**
 * Ventana modal con el QR de activación tras aceptar una solicitud (o reemitir el enlace). El
 * enlace se muestra una sola vez: al cerrarla se avisa de que habrá que generar otro desde la
 * ficha del paciente (Portal del paciente) si no lo ha escaneado.
 */
export default function ActivationDialog({ result, personName, context, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [origin, setOrigin] = useState('');
  const id = useId();

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (result && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
      requestAnimationFrame(() => headingRef.current?.focus());
    } else if (!result && dialog.open) {
      dialog.close();
    }
  }, [result]);

  function handleClosed() {
    onClose();
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target && document.contains(target)) target.focus();
  }

  return (
    <dialog ref={dialogRef} className="agenda-modal ps-dialog ps-dialog-wide" aria-labelledby={`${id}-title`} onClose={handleClosed}>
      {result && origin && (
        <>
          <div className="agenda-modal-header">
            <div>
              {context && <p className="ps-dialog-kicker">{context}</p>}
              <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1}>
                {personName ? `Entrega el acceso a ${personName}` : 'Entrega el acceso en persona'}
              </h2>
            </div>
            <button type="button" aria-label="Cerrar" onClick={() => dialogRef.current?.close()}>×</button>
          </div>
          <ActivationHandoff activation={result.activation} origin={origin} />
          <p className="ps-dialog-foot">
            Este código no se volverá a mostrar. Si no llega a escanearlo, genera uno nuevo desde
            {result.patientId ? <> el <Link href={`/patients/${result.patientId}/portal`}>portal del paciente</Link> en su ficha</> : ' el portal del paciente en su ficha'}.
          </p>
          <div className="agenda-modal-actions">
            {result.patientId && <Link className="button secondary" href={`/patients/${result.patientId}`}>Abrir su ficha</Link>}
            <button type="button" className="button" onClick={() => dialogRef.current?.close()}>Hecho</button>
          </div>
        </>
      )}
    </dialog>
  );
}
