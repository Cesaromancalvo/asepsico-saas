import { strToU8, zipSync } from 'fflate';
import { IMPORT_LIMITS } from '../src/patient-import/import-limits';
import { readXlsx } from '../src/patient-import/parsing/xlsx-reader';
import { decodeEntities, decodeXmlPart, richText } from '../src/patient-import/parsing/xml-scan';
import { validateRows } from '../src/patient-import/row-validation';

// Casos límite del escáner XML del lector de XLSX que pidió Argos (01/10).
// Datos 100 % ficticios.

const WORKBOOK = {
  'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="H" sheetId="1" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
};
const book = (sheet: Uint8Array, sharedStrings?: Uint8Array) =>
  Buffer.from(zipSync({ ...WORKBOOK, 'xl/worksheets/sheet1.xml': sheet, ...(sharedStrings ? { 'xl/sharedStrings.xml': sharedStrings } : {}) }));
const sheet = (rows: string) => strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`);
const cell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const NAME_COLUMNS = [
  { index: 0, field: 'nombre' as const },
  { index: 1, field: 'apellidos' as const },
];

describe('Escáner XML: DOCTYPE y ENTITY', () => {
  it('rechaza <!doctype en minúsculas (y con espacios raros) en la hoja', () => {
    for (const doctype of ['<!doctype x [<!entity e "z">]>', '<!DocType x>', '<!doctype\nx>']) {
      const xml = strToU8(`${doctype}<worksheet><sheetData><row r="1">${cell('A1', '&e;')}</row></sheetData></worksheet>`);
      expect(() => readXlsx(book(xml))).toThrow(expect.objectContaining({ code: 'INVALID_XLSX' }));
    }
  });

  it('rechaza una declaración ENTITY dentro de sharedStrings aunque no haya DOCTYPE', () => {
    const shared = strToU8('<sst><si><t>Ficticia</t></si><!ENTITY e SYSTEM "file:///etc/hostname"><si><t>&e;</t></si></sst>');
    const rows = sheet(`<row r="1"><c r="A1" t="s"><v>1</v></c></row>`);
    expect(() => readXlsx(book(rows, shared))).toThrow(expect.objectContaining({ code: 'INVALID_XLSX' }));
    expect(() => decodeXmlPart(Buffer.from('<sst><!entity e "x"></sst>'))).toThrow(expect.objectContaining({ code: 'INVALID_XLSX' }));
  });

  it('una entidad no predefinida sin DTD no se expande: queda como texto literal', () => {
    expect(decodeEntities('A&e;B&lol;')).toBe('A&e;B&lol;');
  });
});

describe('Escáner XML: referencias de entidad', () => {
  it('&amp;lt; se decodifica UNA sola vez (queda "&lt;", nunca "<")', () => {
    expect(decodeEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
    expect(decodeEntities('&amp;amp;')).toBe('&amp;');
    const parsed = readXlsx(book(sheet(`<row r="1">${cell('A1', '&amp;lt;script&amp;gt;')}</row>`)));
    expect(parsed.rows[0].cells[0]).toBe('&lt;script&gt;');
  });

  it('referencias numéricas fuera de rango o nulas se descartan', () => {
    expect(decodeEntities('a&#0;b&#x110000;c&#1114112;d')).toBe('abcd');
    expect(decodeEntities('&#x41;&#66;')).toBe('AB');
  });

  // BUG (código, sin arreglar): &#xD800; produce un surrogate suelto que pasa la validación como
  // VALID; al confirmar, Prisma rechaza el valor (InvalidArg) y falla el bloque ENTERO, también
  // en cada reintento: el lote se queda en PARTIAL sin poder importar ninguna de sus 100 filas
  // (reproducido por HTTP contra PostgreSQL real). Cuando se arregle (descartar U+D800–U+DFFF en
  // decodeEntities o marcar la fila como INVALID_TEXT), este test empezará a "fallar": cámbialo
  // entonces de it.failing a it.
  it.failing('&#xD800; (surrogate suelto) no llega como dato válido a la confirmación', () => {
    const parsed = readXlsx(book(sheet(`<row r="1">${cell('A1', 'Ana&#xD800;')}${cell('B1', 'Ficticia')}</row>`)));
    const [row] = validateRows(parsed.rows, NAME_COLUMNS, { format: 'XLSX', date1904: false });
    const loneSurrogate = /[\uD800-\uDFFF]/.test(String(row.values.firstName ?? ''));
    expect(row.kind === 'ERROR' || !loneSurrogate).toBe(true);
  });
});

describe('Escáner XML: CDATA', () => {
  // BUG (código, menor, sin arreglar): el contenido CDATA se importa LITERAL, con los
  // delimitadores: "<![CDATA[Ana]]>" acaba como nombre VALID del paciente. Excel no escribe
  // CDATA, pero otras herramientas sí. Tampoco se respeta el marcado dentro de CDATA (un "</t>"
  // interno cierra la celda), sin impacto de seguridad: quien sube el fichero controla todo su
  // contenido igualmente. Al arreglarlo (decodificar CDATA o rechazar la fila),
  // cambia it.failing por it.
  it.failing('el texto de una celda CDATA no se importa con los delimitadores "<![CDATA["', () => {
    const parsed = readXlsx(book(sheet(`<row r="1">${cell('A1', '<![CDATA[Ana]]>')}${cell('B1', 'Ficticia')}</row>`)));
    const [row] = validateRows(parsed.rows, NAME_COLUMNS, { format: 'XLSX', date1904: false });
    expect(row.kind === 'ERROR' || !String(row.values.firstName).includes('CDATA')).toBe(true);
  });

  it('richText concatena los <t> del texto enriquecido', () => {
    expect(richText('<r><t>Ana</t></r><r><t xml:space="preserve"> Ficticia</t></r>')).toBe('Ana Ficticia');
  });
});

describe('Escáner XML: codificación', () => {
  it('una parte en UTF-16 (con DOCTYPE dentro) no produce filas ni expande entidades', () => {
    const utf16 = (xml: string) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    const withDtd = utf16(
      `<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x [<!ENTITY e "expandida">]><worksheet><sheetData><row r="1">${cell('A1', '&e;')}</row></sheetData></worksheet>`,
    );
    const plain = utf16(`<worksheet><sheetData><row r="1">${cell('A1', 'Ana')}</row></sheetData></worksheet>`);
    for (const part of [withDtd, plain]) {
      let rows: unknown[] = [];
      try {
        rows = readXlsx(book(part)).rows;
      } catch (error) {
        expect(error).toEqual(expect.objectContaining({ code: 'INVALID_XLSX' }));
      }
      // Se lee como UTF-8: el marcado intercalado con NUL no casa con ninguna etiqueta, así que
      // no hay filas (la subida termina en EMPTY_FILE) y nunca aparece el texto de la entidad.
      expect(rows).toEqual([]);
      expect(JSON.stringify(rows)).not.toContain('expandida');
    }
  });
});

describe('Escáner XML: etiqueta sin cerrar de ~15 MB', () => {
  const size = IMPORT_LIMITS.MAX_XLSX_PART_BYTES - 256;
  const cases: Record<string, string> = {
    'atributos sin ">"': `<worksheet><sheetData><row r="1"><c r="A1"${' '.repeat(size)}`,
    'texto sin "</t>"': `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${'A'.repeat(size)}`,
    'solo "<"': `<worksheet><sheetData><row r="1">${'<'.repeat(size)}`,
  };

  it.each(Object.entries(cases))('%s: se rechaza en < 3 s y con memoria acotada', (_name, xml) => {
    const file = book(strToU8(xml));
    expect(file.length).toBeLessThan(IMPORT_LIMITS.MAX_FILE_BYTES);
    const rssBefore = process.memoryUsage().rss;
    const started = Date.now();
    expect(() => readXlsx(file)).toThrow(expect.objectContaining({ code: 'INVALID_XLSX' }));
    const elapsedMs = Date.now() - started;
    const rssGrowthMb = (process.memoryUsage().rss - rssBefore) / (1024 * 1024);
    expect(elapsedMs).toBeLessThan(3000);
    // ~15 MB de XML: descomprimido + texto decodificado. Medido en local: ≤ 66 MB de crecimiento.
    expect(rssGrowthMb).toBeLessThan(150);
  }, 30_000);
});
