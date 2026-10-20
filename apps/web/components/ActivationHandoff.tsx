import type { PortalSignupAcceptedContract } from '@asepsico/contracts';
import QrCode from './QrCode';
import { activationUrl, formatDateTime } from '@/lib/portal-signup';

type Props = {
  activation: PortalSignupAcceptedContract['activation'];
  /** Origen de la web (window.location.origin), para componer el enlace. */
  origin: string;
};

/**
 * Enlace de activación de la cuenta del portal. Condición de Argos (delivery IN_PERSON_ONLY):
 * se entrega en persona, escaneando el QR desde esta pantalla. No hay ningún botón de enviar,
 * copiar ni compartir; el enlace en texto solo está como último recurso, plegado.
 */
export default function ActivationHandoff({ activation, origin }: Props) {
  const url = activationUrl(origin, activation.token);
  return (
    <div className="ps-handoff">
      <div className="ps-handoff-qr">
        <QrCode value={url} label="Código QR para activar la cuenta del portal" size={220} />
      </div>
      <div className="ps-handoff-copy">
        <ol className="ps-steps">
          <li>Pide al paciente que abra la cámara de su móvil y escanee este código.</li>
          <li>En su móvil elegirá su contraseña. Nadie más la conocerá.</li>
          <li>Cuando vea «Tu cuenta está activa», puedes cerrar esta ventana.</li>
        </ol>
        <p className="ps-handoff-expiry">
          Vale una sola vez y caduca el <strong>{formatDateTime(activation.expiresAt)}</strong>.
        </p>
        <p className="ps-handoff-warning" role="note">
          Entrégalo solo en persona. No lo envíes por correo ni por mensajería: así nadie más puede activar su cuenta.
        </p>
        <details className="ps-details">
          <summary>No puede escanearlo</summary>
          <p>Que escriba esta dirección en el navegador de su móvil:</p>
          <p className="ps-url" translate="no">{url}</p>
        </details>
      </div>
    </div>
  );
}
