import { strToU8, zipSync } from 'fflate';
import { IMPORT_FIELDS } from './column-mapping';
import { ROW_ISSUE_MESSAGES, RowIssueCode } from './row-validation';

/**
 * Ficheros que genera la API: plantilla (CSV y XLSX) e informe de errores (CSV).
 * La fila de ejemplo es ficticia y se reconoce por "EJEMPLO" en la columna nombre.
 */
const EXAMPLE_ROW = ['EJEMPLO', 'Apellido Ficticio', 'ejemplo@example.com', '600 000 000', '+34', '01/01/1990', 'activo'];

/**
 * Neutraliza la inyección de fórmulas al abrir el CSV en una hoja de cálculo (OWASP "CSV
 * injection"): una celda que empieza por = + - @ tabulador o retorno se prefija con comilla.
 */
export function neutralizeCsvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const BOM = '﻿';
const toCsv = (rows: string[][], cell: (value: string) => string) =>
  `${BOM}${rows.map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`;

/** Plantilla: contenido fijo nuestro (sin datos de nadie), así que "+34" se escribe tal cual. */
export function templateCsv(): Buffer {
  return Buffer.from(toCsv([[...IMPORT_FIELDS], EXAMPLE_ROW], (value) => value), 'utf8');
}

const xmlEscape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const columnLetter = (index: number) => String.fromCharCode(65 + index);

function inlineRow(rowNumber: number, values: string[]): string {
  const cells = values
    .map((value, index) => `<c r="${columnLetter(index)}${rowNumber}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`)
    .join('');
  return `<row r="${rowNumber}">${cells}</row>`;
}

/** XLSX mínimo (una hoja, celdas de texto en línea: el teléfono conserva ceros y espacios). */
export function templateXlsx(): Buffer {
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files = {
    '[Content_Types].xml': `${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${header}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Pacientes" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `${header}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${inlineRow(1, [...IMPORT_FIELDS])}${inlineRow(2, EXAMPLE_ROW)}</sheetData></worksheet>`,
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)]))));
}

export interface ErrorReportEntry {
  row: number;
  field: string;
  code: RowIssueCode;
}

/** Informe de errores: número de fila, columna y motivo. NUNCA los datos de la fila. */
export function errorReportCsv(entries: ErrorReportEntry[]): Buffer {
  const rows = [['fila', 'columna', 'motivo'], ...entries.map((e) => [String(e.row), e.field, ROW_ISSUE_MESSAGES[e.code] ?? e.code])];
  return Buffer.from(toCsv(rows, neutralizeCsvCell), 'utf8');
}
