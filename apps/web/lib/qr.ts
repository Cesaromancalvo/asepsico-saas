import qrcode from 'qrcode-generator';

/*
 * Códigos QR generados en el navegador (sin servicios externos ni scripts en línea). Se pintan
 * como SVG de React, así que no hay innerHTML ni imágenes remotas: compatible con la CSP.
 */

/** Matriz de módulos (true = oscuro). Corrección de errores M: aguanta bien una impresión normal. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

/** Trazado SVG de los módulos oscuros, desplazado por el margen (zona tranquila). */
export function qrPath(matrix: boolean[][], margin: number): string {
  const parts: string[] = [];
  matrix.forEach((cells, row) => {
    cells.forEach((dark, col) => {
      if (dark) parts.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    });
  });
  return parts.join('');
}

/** Margen recomendado por la norma (4 módulos). */
export const QR_MARGIN = 4;

/** SVG completo como texto, para descargarlo. Solo contiene el trazado: nada ejecutable. */
export function qrSvgDocument(text: string, title: string): string {
  const matrix = qrMatrix(text);
  const size = matrix.length + QR_MARGIN * 2;
  const safeTitle = title.replace(/[<>&"]/g, '');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="1024" height="1024" shape-rendering="crispEdges">`,
    `<title>${safeTitle}</title>`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<path fill="#000000" d="${qrPath(matrix, QR_MARGIN)}"/>`,
    '</svg>',
  ].join('');
}
