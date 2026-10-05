import { Unzip, UnzipInflate } from 'fflate';
import { IMPORT_LIMITS } from '../import-limits';
import { ImportFileError } from './import-file-error';
import { RawRow, RawSheet } from './raw-table';
import { attr, childText, decodeXmlPart, eachElement, firstElement, resetXmlScan, richText } from './xml-scan';

/**
 * Lector de XLSX con superficie mínima:
 *
 * - ZIP con `fflate` (mantenida, sin dependencias) en modo streaming: los límites de tamaño se
 *   aplican MIENTRAS se descomprime, contando bytes reales (el tamaño declarado en la cabecera
 *   del ZIP puede mentir). La entrada se empuja en trozos pequeños para que un trozo no pueda
 *   expandirse a más de ~16 MB antes de comprobarse (protección frente a ZIP bomb).
 * - Solo se descomprimen las partes necesarias (workbook, rels, sharedStrings, hojas). Macros
 *   (vbaProject.bin), objetos incrustados, enlaces externos y el resto se ignoran sin leerlos.
 * - XML recorrido en lineal con `xml-scan.ts`, sin montar árbol (memoria ≈ tamaño del XML) y
 *   rechazando cualquier DOCTYPE/ENTITY (sin entidades externas ni expansión de entidades).
 * - Fórmulas: nunca se evalúan. De una celda con fórmula solo se lee el valor calculado que
 *   Excel dejó guardado (`<v>`); el texto de la fórmula (`<f>`) se ignora.
 */

const WANTED_PART = /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/;
const PUSH_CHUNK_BYTES = 16 * 1024;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

const startsWith = (buf: Buffer, magic: number[]) => magic.every((b, i) => buf[i] === b);

export function isLegacyXls(buffer: Buffer): boolean {
  return startsWith(buffer, OLE_MAGIC);
}

export function isZip(buffer: Buffer): boolean {
  return startsWith(buffer, ZIP_MAGIC);
}

export function unzipXlsxParts(buffer: Buffer): Map<string, Buffer> {
  const parts = new Map<string, Buffer>();
  let failure: ImportFileError | null = null;
  let entries = 0;
  let totalBytes = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (failure) return;
    entries += 1;
    if (entries > IMPORT_LIMITS.MAX_ZIP_ENTRIES) {
      failure = new ImportFileError('INVALID_XLSX');
      return;
    }
    if (!WANTED_PART.test(file.name)) return; // no se llama a start(): no se descomprime
    if (file.compression !== 0 && file.compression !== 8) {
      failure = new ImportFileError('INVALID_XLSX');
      return;
    }
    if (file.originalSize !== undefined && file.originalSize > IMPORT_LIMITS.MAX_XLSX_PART_BYTES) {
      failure = new ImportFileError('XLSX_TOO_LARGE_UNCOMPRESSED');
      return;
    }
    const chunks: Uint8Array[] = [];
    let partBytes = 0;
    file.ondata = (err, data, final) => {
      if (failure) return;
      if (err) {
        failure = new ImportFileError('INVALID_XLSX');
        file.terminate();
        return;
      }
      partBytes += data.length;
      totalBytes += data.length;
      if (partBytes > IMPORT_LIMITS.MAX_XLSX_PART_BYTES || totalBytes > IMPORT_LIMITS.MAX_XLSX_TOTAL_BYTES) {
        failure = new ImportFileError('XLSX_TOO_LARGE_UNCOMPRESSED');
        file.terminate();
        return;
      }
      chunks.push(data);
      if (final) parts.set(file.name, Buffer.concat(chunks));
    };
    file.start();
  };

  try {
    for (let offset = 0; offset < buffer.length && !failure; offset += PUSH_CHUNK_BYTES) {
      const end = Math.min(offset + PUSH_CHUNK_BYTES, buffer.length);
      unzip.push(buffer.subarray(offset, end), end === buffer.length);
    }
  } catch {
    // Sin detalle: el mensaje de la librería podría incluir fragmentos del fichero.
    throw new ImportFileError('INVALID_XLSX');
  }
  if (failure) throw failure;
  return parts;
}

/** "B12" → 1 (índice de columna en base 0). */
function columnIndex(ref: string | undefined): number | null {
  const letters = /^([A-Z]+)\d+$/i.exec(ref ?? '')?.[1];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function cellValue(attrs: string, inner: string, sharedStrings: string[]): string {
  const type = attr(attrs, 't');
  if (type === 's') {
    const index = Number(childText(inner, 'v'));
    return Number.isInteger(index) ? (sharedStrings[index] ?? '') : '';
  }
  if (type === 'inlineStr') {
    const inline = firstElement(inner, 'is');
    return inline ? richText(inline.inner) : '';
  }
  if (type === 'e') return ''; // #N/A, #REF!…: sin valor
  if (type === 'b') return childText(inner, 'v') === '1' ? 'TRUE' : 'FALSE';
  // 'n' (número), 'str' (resultado de fórmula), 'd' (fecha ISO): el valor calculado, nunca <f>.
  return childText(inner, 'v');
}

export function readXlsx(buffer: Buffer, requestedSheet = 0): RawSheet {
  try {
    return readXlsxParts(buffer, requestedSheet);
  } finally {
    resetXmlScan(); // no retener textos del fichero entre peticiones
  }
}

function readXlsxParts(buffer: Buffer, requestedSheet: number): RawSheet {
  const parts = unzipXlsxParts(buffer);
  const workbook = decodeXmlPart(parts.get('xl/workbook.xml'));
  const relsXml = decodeXmlPart(parts.get('xl/_rels/workbook.xml.rels'));

  const sheets: Array<{ name: string; relId: string }> = [];
  eachElement(workbook, 'sheet', (el) => {
    sheets.push({ name: attr(el.attrs, 'name') ?? '', relId: attr(el.attrs, 'id') ?? '' });
  });
  if (!sheets.length) throw new ImportFileError('INVALID_XLSX');
  if (!Number.isInteger(requestedSheet) || requestedSheet < 0 || requestedSheet >= sheets.length) {
    throw new ImportFileError('SHEET_NOT_FOUND');
  }

  const workbookPr = firstElement(workbook, 'workbookPr');
  const date1904Attr = (workbookPr ? attr(workbookPr.attrs, 'date1904') ?? '' : '').toLowerCase();
  const sheet = sheets[requestedSheet];
  let target = '';
  eachElement(relsXml, 'Relationship', (el) => {
    if (attr(el.attrs, 'Id') !== sheet.relId) return true;
    target = attr(el.attrs, 'Target') ?? '';
    return false;
  });
  const sheetPath = `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`;
  if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(sheetPath)) throw new ImportFileError('INVALID_XLSX');

  const sharedStrings: string[] = [];
  if (parts.has('xl/sharedStrings.xml')) {
    eachElement(decodeXmlPart(parts.get('xl/sharedStrings.xml')), 'si', (el) => {
      sharedStrings.push(richText(el.inner).slice(0, IMPORT_LIMITS.MAX_CELL_CHARS));
    });
  }

  const sheetXml = decodeXmlPart(parts.get(sheetPath));
  const sheetData = firstElement(sheetXml, 'sheetData');
  const rows: RawRow[] = [];
  let sequentialRow = 0;
  eachElement(sheetData?.inner ?? '', 'row', (xmlRow) => {
    const declared = Number(attr(xmlRow.attrs, 'r'));
    const rowNumber = Number.isInteger(declared) && declared > 0 ? declared : sequentialRow + 1;
    sequentialRow = rowNumber;
    const cells: string[] = [];
    let nextColumn = 0;
    eachElement(xmlRow.inner, 'c', (cell) => {
      const column = columnIndex(attr(cell.attrs, 'r')) ?? nextColumn;
      nextColumn = column + 1;
      const value = cellValue(cell.attrs, cell.inner, sharedStrings).slice(0, IMPORT_LIMITS.MAX_CELL_CHARS);
      if (column >= IMPORT_LIMITS.MAX_COLUMNS) {
        if (value.trim() !== '') throw new ImportFileError('TOO_MANY_COLUMNS');
        return true;
      }
      while (cells.length < column) cells.push('');
      cells[column] = value;
      return true;
    });
    if (!cells.some((value) => value.trim() !== '')) return true;
    // Se corta en cuanto se pasa del límite: no se sigue recorriendo la hoja.
    if (rows.length >= IMPORT_LIMITS.MAX_DATA_ROWS + 1) throw new ImportFileError('TOO_MANY_ROWS');
    rows.push({ rowNumber, cells });
    return true;
  });

  return {
    sheetNames: sheets.map((s) => s.name),
    sheetIndex: requestedSheet,
    date1904: date1904Attr === '1' || date1904Attr === 'true',
    rows,
  };
}
