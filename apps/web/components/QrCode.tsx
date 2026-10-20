import { useMemo } from 'react';
import { QR_MARGIN, qrMatrix, qrPath } from '@/lib/qr';

type Props = {
  value: string;
  /** Texto alternativo para lectores de pantalla (nunca el enlace ni el token). */
  label: string;
  size?: number;
  className?: string;
};

/** Código QR en SVG (negro sobre blanco, con su zona tranquila) para pantalla e impresión. */
export default function QrCode({ value, label, size = 240, className }: Props) {
  const { path, modules } = useMemo(() => {
    const matrix = qrMatrix(value);
    return { path: qrPath(matrix, QR_MARGIN), modules: matrix.length + QR_MARGIN * 2 };
  }, [value]);

  return (
    <svg
      className={className}
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
