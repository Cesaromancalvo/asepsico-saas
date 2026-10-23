import QrCode from './QrCode';

/**
 * Cartel imprimible del QR fijo de alta. Solo el código y un texto genérico: ni el nombre del
 * profesional ni el enlace en texto (lo comprueba test/portal-signup.spec.tsx).
 */
export default function QrPoster({ value }: { value: string }) {
  return (
    <div className="ps-print-area">
      <div className="ps-poster">
        <p className="ps-poster-kicker">Portal de pacientes</p>
        <QrCode value={value} label="Código QR de alta en el portal" size={232} className="ps-qr-svg" />
        <p className="ps-poster-title">Escanéalo con la cámara de tu móvil</p>
        <p className="ps-poster-text">para pedir tu acceso al portal. Tu consulta lo revisará contigo.</p>
      </div>
    </div>
  );
}
