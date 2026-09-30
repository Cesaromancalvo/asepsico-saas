import { Unzip, UnzipInflate } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { IMPORT_LIMITS } from '../import-limits';
import { ImportFileError } from './import-file-error';
import { RawRow, RawSheet } from './raw-table';

/**
 * Lector de XLSX con superficie mínima:
 *
 * - ZIP con `fflate` (mantenida, sin dependencias) en modo streaming: los límites de tamaño se
 *   aplican MIENTRAS se descomprime, contando bytes reales (el tamaño declarado en la cabecera
 *   del ZIP puede mentir). La entrada se empuja en trozos pequeños para que un trozo no pueda
 *   expandirse a más de ~16 MB antes de comprobarse (protección frente a ZIP bomb).
 * - Solo se descomprimen las partes necesarias (workbook, rels, sharedStrings, hojas). Macros
 *   (vbaProject.bin), objetos incrustados, enlaces externos y el resto se ignoran sin leerlos.
 * - XML con `fast-xml-parser`, rechazando cualquier DOCTYPE/ENTITY antes de parsear (sin
 *   entidades externas ni expansión de entidades).
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

const ARRAY_TAGS = new Set(['sheet', 'Relationship', 'si', 'r', 'row', 'c']);
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  htmlEntities: false,
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
});

function parseXml(part: Buffer | undefined): any {
  if (!part) throw new ImportFileError('INVALID_XLSX');
  const text = new TextDecoder('utf-8').decode(part);
  // Sin DTD no hay entidades externas ni "billion laughs": se rechaza antes de parsear.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ImportFileError('INVALID_XLSX');
  try {
    return xmlParser.parse(text);
  } catch {
    throw new ImportFileError('INVALID_XLSX');
  }
}

function textOf(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('#text' in obj) return textOf(obj['#text']);
    // Texto enriquecido: <si><r><t>..</t></r><r><t>..</t></r></si>; se ignoran rPh (fonética).
    if ('r' in obj) return textOf((obj.r as unknown[]).map((run) => (run as Record<string, unknown>)?.t));
    if ('t' in obj) return textOf(obj.t);
  }
  return '';
}

/** "B12" → 1 (índice de columna en base 0). */
function columnIndex(ref: string | undefined): number | null {
  const letters = /^([A-Z]+)\d+$/i.exec(ref ?? '')?.[1];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function cellValue(cell: Record<string, any>, sharedStrings: string[]): string {
  const type = cell['@_t'];
  if (type === 's') {
    const index = Number(textOf(cell.v));
    return Number.isInteger(index) ? (sharedStrings[index] ?? '') : '';
  }
  if (type === 'inlineStr') return textOf(cell.is);
  if (type === 'e') return ''; // #N/A, #REF!…: sin valor
  if (type === 'b') return textOf(cell.v) === '1' ? 'TRUE' : 'FALSE';
  // 'n' (número), 'str' (resultado de fórmula), 'd' (fecha ISO): el valor calculado, nunca <f>.
  return textOf(cell.v);
}

export function readXlsx(buffer: Buffer, requestedSheet = 0): RawSheet {
  const parts = unzipXlsxParts(buffer);
  const workbook = parseXml(parts.get('xl/workbook.xml'))?.workbook;
  const rels = parseXml(parts.get('xl/_rels/workbook.xml.rels'))?.Relationships?.Relationship ?? [];
  const sheets: Array<Record<string, string>> = workbook?.sheets?.sheet ?? [];
  if (!sheets.length) throw new ImportFileError('INVALID_XLSX');
  if (!Number.isInteger(requestedSheet) || requestedSheet < 0 || requestedSheet >= sheets.length) {
    throw new ImportFileError('SHEET_NOT_FOUND');
  }

  const date1904Attr = String(workbook?.workbookPr?.['@_date1904'] ?? '').toLowerCase();
  const sheet = sheets[requestedSheet];
  const rel = (rels as Array<Record<string, string>>).find((r) => r['@_Id'] === sheet['@_id']);
  const target = (rel?.['@_Target'] ?? '').replace(/^\/?xl\//, '').replace(/^\//, '');
  const sheetPath = `xl/${target}`;
  if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(sheetPath)) throw new ImportFileError('INVALID_XLSX');

  const sharedStrings = parts.has('xl/sharedStrings.xml')
    ? ((parseXml(parts.get('xl/sharedStrings.xml'))?.sst?.si ?? []) as unknown[]).map((si) =>
        textOf(si).slice(0, IMPORT_LIMITS.MAX_CELL_CHARS),
      )
    : [];

  const xmlRows: Array<Record<string, any>> = parseXml(parts.get(sheetPath))?.worksheet?.sheetData?.row ?? [];
  const rows: RawRow[] = [];
  let sequentialRow = 0;
  for (const xmlRow of xmlRows) {
    const declared = Number(xmlRow['@_r']);
    const rowNumber = Number.isInteger(declared) && declared > 0 ? declared : sequentialRow + 1;
    sequentialRow = rowNumber;
    const cells: string[] = [];
    let nextColumn = 0;
    for (const cell of (xmlRow.c ?? []) as Array<Record<string, any>>) {
      const column = columnIndex(cell['@_r']) ?? nextColumn;
      nextColumn = column + 1;
      const value = cellValue(cell, sharedStrings).slice(0, IMPORT_LIMITS.MAX_CELL_CHARS);
      if (column >= IMPORT_LIMITS.MAX_COLUMNS) {
        if (value.trim() !== '') throw new ImportFileError('TOO_MANY_COLUMNS');
        continue;
      }
      while (cells.length < column) cells.push('');
      cells[column] = value;
    }
    if (!cells.some((value) => value.trim() !== '')) continue;
    if (rows.length >= IMPORT_LIMITS.MAX_DATA_ROWS + 1) throw new ImportFileError('TOO_MANY_ROWS');
    rows.push({ rowNumber, cells });
  }

  return {
    sheetNames: sheets.map((s) => String(s['@_name'] ?? '')),
    sheetIndex: requestedSheet,
    date1904: date1904Attr === '1' || date1904Attr === 'true',
    rows,
  };
}
