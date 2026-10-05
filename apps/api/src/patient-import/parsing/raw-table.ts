/** Fila leída del fichero, con su número real (el que ve el usuario en Excel o en el editor). */
export interface RawRow {
  rowNumber: number;
  cells: string[];
}

export interface RawSheet {
  /** Nombres de todas las hojas (solo XLSX), para que el usuario pueda elegir otra. */
  sheetNames: string[];
  sheetIndex: number;
  /** Solo XLSX: el libro usa el sistema de fechas de 1904 (Excel antiguo de Mac). */
  date1904: boolean;
  rows: RawRow[];
}

export type ImportFormat = 'CSV' | 'XLSX';
