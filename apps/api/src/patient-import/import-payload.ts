import { GoneException } from '@nestjs/common';
import { decryptFieldStrict, encryptField, isEncryptedValue } from '../common/crypto/field-encryption';
import { isClinicalHeader } from './column-mapping';
import { ImportFormat, RawRow, RawSheet } from './parsing/raw-table';

/**
 * Tabla leída del fichero, lo único que se conserva entre la subida y la confirmación. Se guarda
 * CIFRADA (AES-256-GCM, misma clave que los campos clínicos) en PatientImportJob.payload, ligada
 * al workspace y al importador, y se borra al confirmar, al cancelar o a las 24 horas.
 *
 * El fichero original (y su nombre) no se guarda nunca. Las celdas de las columnas con cabecera
 * clínica se vacían aquí, antes de guardar nada: ese contenido no llega a persistirse.
 */
export interface ImportPayload {
  v: 1;
  format: ImportFormat;
  sheetNames: string[];
  sheetIndex: number;
  date1904: boolean;
  columnCount: number;
  /** Índices de columnas con cabecera potencialmente clínica: vacías y no asignables. */
  clinicalColumns: number[];
  /** Todas las filas no vacías, incluida la primera (cabecera o no, lo decide el usuario). */
  rows: RawRow[];
}

export function buildPayload(format: ImportFormat, sheet: RawSheet): ImportPayload {
  const columnCount = sheet.rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const header = sheet.rows[0]?.cells ?? [];
  const clinicalColumns: number[] = [];
  for (let index = 0; index < columnCount; index += 1) {
    if (isClinicalHeader(header[index] ?? '')) clinicalColumns.push(index);
  }
  const rows = sheet.rows.map((row, position) => ({
    rowNumber: row.rowNumber,
    // En la primera fila se conserva el texto de la cabecera ("Observaciones"), no un dato.
    cells: position === 0 ? row.cells : row.cells.map((cell, index) => (clinicalColumns.includes(index) ? '' : cell)),
  }));
  return {
    v: 1,
    format,
    sheetNames: sheet.sheetNames,
    sheetIndex: sheet.sheetIndex,
    date1904: sheet.date1904,
    columnCount,
    clinicalColumns,
    rows,
  };
}

export function sealPayload(payload: ImportPayload): string {
  const sealed = encryptField(JSON.stringify(payload));
  if (!sealed || !isEncryptedValue(sealed)) throw new Error('No se pudo cifrar el fichero temporal');
  return sealed;
}

export function openPayload(sealed: string | null | undefined): ImportPayload {
  if (!sealed || !isEncryptedValue(sealed)) throw expiredPayload();
  try {
    const payload = JSON.parse(decryptFieldStrict(sealed)) as ImportPayload;
    if (payload?.v !== 1 || !Array.isArray(payload.rows)) throw new Error('formato');
    return payload;
  } catch {
    throw expiredPayload();
  }
}

export function expiredPayload() {
  return new GoneException({
    code: 'IMPORT_FILE_EXPIRED',
    message: 'El fichero temporal ya no está disponible (caducó a las 24 horas o se canceló): vuelve a subirlo',
  });
}
