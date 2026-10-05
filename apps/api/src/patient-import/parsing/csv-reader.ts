import { IMPORT_LIMITS } from '../import-limits';
import { ImportFileError } from './import-file-error';
import { RawRow } from './raw-table';

/**
 * Lector de CSV (RFC 4180) sin dependencias. Solo produce texto: no interpreta fórmulas, no
 * evalúa nada y no registra ningún valor.
 *
 * - Codificación: UTF-8 (con o sin BOM); si no es UTF-8 válido, Windows-1252.
 * - Separador: `;`, `,` o tabulador, elegido por frecuencia fuera de comillas en la primera línea.
 * - Límites: filas y columnas se comprueban mientras se lee (no se construye la tabla entera
 *   para rechazarla después).
 */
export function decodeCsvBuffer(buffer: Buffer): string {
  let bytes = buffer;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new ImportFileError('UNSUPPORTED_ENCODING');
  }
  // Un NUL no aparece en un CSV de texto: es un binario renombrado (o UTF-16 sin BOM).
  if (bytes.includes(0)) throw new ImportFileError('INVALID_CSV');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function detectDelimiter(text: string): ';' | ',' | '\t' {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && ch in counts) counts[ch as keyof typeof counts] += 1;
  }
  // En caso de empate gana `;` (lo habitual en la configuración regional española).
  if (counts[';'] >= counts[','] && counts[';'] >= counts['\t'] && counts[';'] > 0) return ';';
  if (counts['\t'] > counts[',']) return '\t';
  return counts[','] > 0 ? ',' : ';';
}

/**
 * Devuelve las filas tal cual (incluida la primera, que puede ser la cabecera) con su número de
 * registro. Las filas totalmente vacías se descartan. `maxRows` cuenta filas no vacías.
 */
export function parseCsv(text: string, maxRows = IMPORT_LIMITS.MAX_DATA_ROWS + 1): RawRow[] {
  const delimiter = detectDelimiter(text);
  const rows: RawRow[] = [];
  let recordNumber = 0;
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  const pushCell = () => {
    if (row.length >= IMPORT_LIMITS.MAX_COLUMNS) {
      if (cell.trim() !== '') throw new ImportFileError('TOO_MANY_COLUMNS');
    } else {
      row.push(cell.length > IMPORT_LIMITS.MAX_CELL_CHARS ? cell.slice(0, IMPORT_LIMITS.MAX_CELL_CHARS) : cell);
    }
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    recordNumber += 1;
    if (row.some((value) => value.trim() !== '')) {
      if (rows.length >= maxRows) throw new ImportFileError('TOO_MANY_ROWS');
      rows.push({ rowNumber: recordNumber, cells: row });
    }
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else if (cell.length <= IMPORT_LIMITS.MAX_CELL_CHARS) {
        cell += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      cell = '';
      inQuotes = true;
    } else if (ch === delimiter) {
      pushCell();
    } else if (ch === '\r' || ch === '\n') {
      pushRow();
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
    } else if (cell.length <= IMPORT_LIMITS.MAX_CELL_CHARS) {
      cell += ch;
    }
    i += 1;
  }
  if (inQuotes) throw new ImportFileError('INVALID_CSV');
  if (cell !== '' || row.length > 0) pushRow();
  return rows;
}

export function readCsv(buffer: Buffer): RawRow[] {
  return parseCsv(decodeCsvBuffer(buffer));
}
