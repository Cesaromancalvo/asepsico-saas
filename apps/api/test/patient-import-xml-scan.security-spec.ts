import { strToU8, zipSync } from 'fflate';
import { IMPORT_LIMITS } from '../src/patient-import/import-limits';
import { readXlsx } from '../src/patient-import/parsing/xlsx-reader';
import { readCsv } from '../src/patient-import/parsing/csv-reader';
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

  // Corregido: decodeEntities descarta U+D800–U+DFFF y la validación rechaza cualquier surrogate
  // suelto como INVALID_TEXT (además, un fallo de datos al guardar ya no bloquea el lote).
  it('&#xD800; (surrogate suelto) no llega como dato válido a la confirmación', () => {
    const parsed = readXlsx(book(sheet(`<row r="1">${cell('A1', 'Ana&#xD800;')}${cell('B1', 'Ficticia')}</row>`)));
    const [row] = validateRows(parsed.rows, NAME_COLUMNS, { format: 'XLSX', date1904: false });
    const loneSurrogate = /[\uD800-\uDFFF]/.test(String(row.values.firstName ?? ''));
    expect(row.kind === 'ERROR' || !loneSurrogate).toBe(true);
  });
});

describe('Escáner XML: CDATA', () => {
  // Corregido: el contenido CDATA se toma literal (sin decodificar entidades) y su marcado interno
  // no cierra la celda.
  it('el texto de una celda CDATA no se importa con los delimitadores "<![CDATA["', () => {
    const parsed = readXlsx(book(sheet(`<row r="1">${cell('A1', '<![CDATA[Ana]]>')}${cell('B1', 'Ficticia')}</row>`)));
    const [row] = validateRows(parsed.rows, NAME_COLUMNS, { format: 'XLSX', date1904: false });
    expect(row.kind === 'ERROR' || !String(row.values.firstName).includes('CDATA')).toBe(true);
  });

  it('richText concatena los <t> del texto enriquecido', () => {
    expect(richText('<r><t>Ana</t></r><r><t xml:space="preserve"> Ficticia</t></r>')).toBe('Ana Ficticia');
  });
});

describe('Escáner XML: codificación', () => {
  it('una parte en UTF-16 (con o sin DOCTYPE) se rechaza con UNSUPPORTED_ENCODING, sin expandir nada', () => {
    const utf16 = (xml: string) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    const withDtd = utf16(
      `<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x [<!ENTITY e "expandida">]><worksheet><sheetData><row r="1">${cell('A1', '&e;')}</row></sheetData></worksheet>`,
    );
    const plain = utf16(`<worksheet><sheetData><row r="1">${cell('A1', 'Ana')}</row></sheetData></worksheet>`);
    const noBom = new Uint8Array(Buffer.from(`<worksheet><sheetData><row r="1">${cell('A1', 'Ana')}</row></sheetData></worksheet>`, 'utf16le'));
    for (const part of [withDtd, plain, noBom]) {
      expect(() => readXlsx(book(part))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ENCODING' }));
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

describe('Correcciones tras la verificación E2E de Quima', () => {
  it('surrogate suelto: la fila sale con INVALID_TEXT y nunca como VALID', () => {
    // Defensa en profundidad: aunque llegara un surrogate suelto por otra vía, la validación lo para.
    const [row] = validateRows([{ rowNumber: 1, cells: ['Ana', 'Ficticia\uD800'] }], NAME_COLUMNS, { format: 'XLSX', date1904: false });
    expect(row.kind).toBe('ERROR');
    expect(row.errors.map((e) => e.code)).toEqual(['INVALID_TEXT']);
    expect(decodeEntities('a&#xD800;b&#57343;c')).toBe('abc');
  });

  it('CDATA: contenido literal (sin decodificar), con "</t>" y "<c" dentro sin cerrar la celda', () => {
    const parsed = readXlsx(
      book(sheet(`<row r="1">${cell('A1', '<![CDATA[Ana </t><c r="Z9"> &amp; Co]]>')}${cell('B1', 'Fic<![CDATA[ti]]>cia &amp; X')}</row>`)),
    );
    expect(parsed.rows[0].cells).toEqual(['Ana </t><c r="Z9"> &amp; Co', 'Ficticia & X']);
    expect(() => readXlsx(book(sheet(`<row r="1">${cell('A1', '<![CDATA[sin cerrar')}</row>`)))).toThrow(
      expect.objectContaining({ code: 'INVALID_XLSX' }),
    );
  });

  it('CDATA en sharedStrings y en <v>', () => {
    const shared = strToU8('<sst><si><t><![CDATA[Eva]]></t></si></sst>');
    const parsed = readXlsx(book(sheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v><![CDATA[42]]></v></c></row>'), shared));
    expect(parsed.rows[0].cells).toEqual(['Eva', '42']);
  });

  it('muchas filas con CDATA: sigue siendo lineal', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `<row r="${i + 1}">${cell(`A${i + 1}`, `<![CDATA[N${i}]]>`)}</row>`).join('');
    const started = Date.now();
    expect(() => readXlsx(book(sheet(many)))).toThrow(expect.objectContaining({ code: 'TOO_MANY_ROWS' }));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('CSV en UTF-16 con BOM → UNSUPPORTED_ENCODING (no "fichero vacío")', () => {
    const csv = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('nombre;apellidos\r\nAna;Ficticia', 'utf16le')]);
    expect(() => readCsv(csv)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ENCODING' }));
  });
});
