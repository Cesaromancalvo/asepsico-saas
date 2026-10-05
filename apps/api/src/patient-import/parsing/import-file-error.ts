import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/**
 * Motivos de rechazo de un fichero. Los mensajes son fijos: nunca incluyen contenido del fichero
 * (ni el nombre, que puede contener datos personales).
 */
export const IMPORT_FILE_ERRORS = {
  FILE_REQUIRED: 'Adjunta un fichero .csv o .xlsx',
  FILE_TOO_LARGE: 'El fichero supera el máximo de 5 MB',
  TOO_MANY_ROWS: 'El fichero supera el máximo de 2.000 filas de datos',
  TOO_MANY_COLUMNS: 'El fichero tiene demasiadas columnas (máximo 50)',
  LEGACY_XLS: 'Los ficheros .xls antiguos no se admiten: guárdalo como .xlsx o .csv',
  UNSUPPORTED_FORMAT: 'Formato no admitido: sube un fichero .csv o .xlsx (.numbers, .ods o .xlsm no se admiten)',
  INVALID_CSV: 'No se ha podido leer el CSV: revisa que sea texto separado por ; , o tabulador',
  INVALID_XLSX: 'No se ha podido leer el Excel: ábrelo y vuelve a guardarlo como .xlsx',
  XLSX_TOO_LARGE_UNCOMPRESSED: 'El Excel es demasiado grande una vez descomprimido',
  SHEET_NOT_FOUND: 'La hoja indicada no existe en el fichero',
  EMPTY_FILE: 'El fichero no contiene filas',
  UNSUPPORTED_ENCODING: 'El fichero usa una codificación no admitida (UTF-16): ábrelo y guárdalo de nuevo como .xlsx o como CSV UTF-8',
} as const;

export type ImportFileErrorCode = keyof typeof IMPORT_FILE_ERRORS;

export class ImportFileError extends Error {
  constructor(readonly code: ImportFileErrorCode) {
    super(IMPORT_FILE_ERRORS[code]);
    this.name = 'ImportFileError';
  }

  toHttp() {
    const body = { code: this.code, message: IMPORT_FILE_ERRORS[this.code] };
    return this.code === 'FILE_TOO_LARGE' || this.code === 'XLSX_TOO_LARGE_UNCOMPRESSED'
      ? new PayloadTooLargeException(body)
      : new BadRequestException(body);
  }
}
