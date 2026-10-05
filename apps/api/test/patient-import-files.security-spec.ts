import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import request = require('supertest');
import { strToU8, zipSync } from 'fflate';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { CsrfGuard } from '../src/common/guards/csrf.guard';
import { proposeMapping } from '../src/patient-import/column-mapping';
import { neutralizeCsvCell, templateCsv, templateXlsx } from '../src/patient-import/import-files';
import { IMPORT_LIMITS } from '../src/patient-import/import-limits';
import { readCsv } from '../src/patient-import/parsing/csv-reader';
import { readXlsx } from '../src/patient-import/parsing/xlsx-reader';
import { PatientImportController } from '../src/patient-import/patient-import.controller';
import { PatientImportConfirmService } from '../src/patient-import/patient-import-confirm.service';
import { PatientImportRevertService } from '../src/patient-import/patient-import-revert.service';
import { PatientImportService } from '../src/patient-import/patient-import.service';
import { validateRows } from '../src/patient-import/row-validation';
import { PatientImportModule } from '../src/patient-import/patient-import.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { FULL_MAPPING, actor, csvFile, prismaMock, services } from './patient-import.fixtures';

// Datos 100 % ficticios.
const therapist = actor('therapist-1', 'THERAPIST');

function xlsx(sheetXml: string, extra: Record<string, Uint8Array> = {}, sharedStrings?: string) {
  return Buffer.from(
    zipSync({
      'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`),
      ...(sharedStrings ? { 'xl/sharedStrings.xml': strToU8(sharedStrings) } : {}),
      ...extra,
    }),
  );
}
const cell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (error: any) {
    return error.code ?? error.getResponse?.()?.code ?? error.message;
  }
  return 'NO_ERROR';
};

describe('Importación: lectura segura de CSV', () => {
  it('CSV en Windows-1252 separado por ; muestra bien tildes y eñes', () => {
    const latin1 = Buffer.from('nombre;apellidos\r\nMaría José;Núñez Ficticia\r\n', 'latin1');
    expect(readCsv(latin1)).toEqual([
      { rowNumber: 1, cells: ['nombre', 'apellidos'] },
      { rowNumber: 2, cells: ['María José', 'Núñez Ficticia'] },
    ]);
  });

  it('UTF-8 con BOM, separador coma, comillas y saltos de línea dentro de comillas', () => {
    const utf8 = Buffer.from('﻿nombre,apellidos\n"Ana, ""Anita""","Ficticia\nSegunda"\n\n', 'utf8');
    expect(readCsv(utf8)).toEqual([
      { rowNumber: 1, cells: ['nombre', 'apellidos'] },
      { rowNumber: 2, cells: ['Ana, "Anita"', 'Ficticia\nSegunda'] },
    ]);
  });

  it('tabulador como separador', () => {
    expect(readCsv(Buffer.from('nombre\tapellidos\nAna\tFicticia'))[1].cells).toEqual(['Ana', 'Ficticia']);
  });

  it('más de 2.000 filas de datos se rechaza; 2.000 exactas se aceptan', () => {
    const rows = (n: number) => ['nombre;apellidos', ...Array.from({ length: n }, (_, i) => `N${i};Ficticio`)].join('\n');
    expect(readCsv(Buffer.from(rows(2000)))).toHaveLength(2001);
    expect(() => readCsv(Buffer.from(rows(2001)))).toThrow(expect.objectContaining({ code: 'TOO_MANY_ROWS' }));
  });

  it('un binario con NUL renombrado a .csv se rechaza', () => {
    expect(() => readCsv(Buffer.from([0x6e, 0x00, 0x6f]))).toThrow(expect.objectContaining({ code: 'INVALID_CSV' }));
  });
});

describe('Importación: lectura segura de XLSX', () => {
  it('lee la plantilla generada e ignora la fila de EJEMPLO', () => {
    const sheet = readXlsx(templateXlsx());
    expect(sheet.rows[0].cells).toEqual(['nombre', 'apellidos', 'email', 'telefono', 'prefijo', 'fecha_nacimiento', 'estado']);
    const mapping = proposeMapping(sheet.rows[0].cells, 7, true).map((c) => ({ index: c.index, field: c.suggestedField as any }));
    const [row] = validateRows(sheet.rows.slice(1), mapping, { format: 'XLSX', date1904: false });
    expect(row).toEqual(expect.objectContaining({ kind: 'IGNORED', ignoredReason: 'EXAMPLE' }));
    // Igual con la plantilla CSV.
    const csv = readCsv(templateCsv());
    expect(validateRows(csv.slice(1), mapping, { format: 'CSV', date1904: false })[0].ignoredReason).toBe('EXAMPLE');
  });

  it('las fórmulas nunca se evalúan: solo se lee el valor guardado, nunca el texto de la fórmula', () => {
    const sheet = readXlsx(
      xlsx(`<row r="1">${cell('A1', 'nombre')}</row><row r="2"><c r="A2" t="str"><f>HYPERLINK("http://example.test","x")</f><v>Ana</v></c><c r="B2"><f>WEBSERVICE("http://example.test")</f></c></row>`),
    );
    expect(sheet.rows[1].cells).toEqual(['Ana', '']);
    expect(JSON.stringify(sheet)).not.toMatch(/HYPERLINK|WEBSERVICE|http/);
  });

  it('rechaza DOCTYPE/ENTITY (XXE y "billion laughs") sin expandir nada', () => {
    const laughs = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>';
    const buf = Buffer.from(
      zipSync({
        'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="H" sheetId="1" r:id="rId1"/></sheets></workbook>'),
        'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
        'xl/worksheets/sheet1.xml': strToU8(laughs),
      }),
    );
    expect(() => readXlsx(buf)).toThrow(expect.objectContaining({ code: 'INVALID_XLSX' }));
    const xxe = '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><sst><si><t>&e;</t></si></sst>';
    expect(() => readXlsx(xlsx(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`, {}, xxe))).toThrow(expect.objectContaining({ code: 'INVALID_XLSX' }));
  });

  it('ZIP bomb: una parte que se expande por encima del límite se corta al descomprimir', () => {
    const zeros = new Uint8Array(IMPORT_LIMITS.MAX_XLSX_PART_BYTES + 1024);
    const bomb = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': zeros }, { level: 9 }));
    expect(bomb.length).toBeLessThan(IMPORT_LIMITS.MAX_FILE_BYTES);
    expect(() => readXlsx(bomb)).toThrow(expect.objectContaining({ code: 'XLSX_TOO_LARGE_UNCOMPRESSED' }));
  });

  it('ZIP bomb repartida en varias partes: el total descomprimido también está limitado', () => {
    const part = new Uint8Array(IMPORT_LIMITS.MAX_XLSX_PART_BYTES - 1024);
    const bomb = Buffer.from(
      zipSync({ 'xl/worksheets/sheet1.xml': part, 'xl/worksheets/sheet2.xml': part }, { level: 9 }),
    );
    expect(() => readXlsx(bomb)).toThrow(expect.objectContaining({ code: 'XLSX_TOO_LARGE_UNCOMPRESSED' }));
  });

  it('ignora macros y partes no necesarias sin descomprimirlas', () => {
    const vba = new Uint8Array(IMPORT_LIMITS.MAX_XLSX_TOTAL_BYTES + 1024);
    const sheet = readXlsx(xlsx(`<row r="1">${cell('A1', 'nombre')}</row>`, { 'xl/vbaProject.bin': vba }));
    expect(sheet.rows).toHaveLength(1);
  });

  it('fechas nativas de Excel (número de serie) en fecha_nacimiento', () => {
    const sheet = readXlsx(xlsx(`<row r="1">${cell('A1', 'n')}</row><row r="2">${cell('A2', 'Ana')}${cell('B2', 'Ficticia')}<c r="C2"><v>29221</v></c></row>`));
    const [row] = validateRows(sheet.rows.slice(1), [
      { index: 0, field: 'nombre' }, { index: 1, field: 'apellidos' }, { index: 2, field: 'fecha_nacimiento' },
    ], { format: 'XLSX', date1904: false });
    expect(row.values.birthDate).toBe('1980-01-01');
  });
});

describe('Importación: mapeo y validación', () => {
  it('propone nombre, apellidos (unidos) y teléfono para "Nombre", "Apellido 1", "Apellido 2", "Móvil"', () => {
    const columns = proposeMapping(['Nombre', 'Apellido 1', 'Apellido 2', 'Móvil', 'Teléfono', 'Observaciones'], 6, true);
    expect(columns.map((c) => c.suggestedField)).toEqual(['nombre', 'apellidos', 'apellidos', 'telefono', 'NO_IMPORTAR', 'NO_IMPORTAR']);
    expect(columns[5].clinical).toBe(true);
    const [row] = validateRows([{ rowNumber: 2, cells: ['Ana', 'Ficticia', 'Prueba', '600 11 22 33', '', ''] }], [
      { index: 0, field: 'nombre' }, { index: 1, field: 'apellidos' }, { index: 2, field: 'apellidos' }, { index: 3, field: 'telefono' },
    ], { format: 'CSV', date1904: false });
    expect(row.values).toEqual(expect.objectContaining({ lastName: 'Ficticia Prueba', phone: '+34 600 11 22 33' }));
  });

  it('errores por columna sin incluir el valor; fecha imposible, email, estado, fórmula en el nombre', () => {
    const rows = validateRows([
      { rowNumber: 2, cells: ['=1+1', 'Ficticia', 'x@', '31/02/1990', 'baja'] },
      { rowNumber: 3, cells: ['', 'Ficticia', '', '01/01/2999', ''] },
    ], [
      { index: 0, field: 'nombre' }, { index: 1, field: 'apellidos' }, { index: 2, field: 'email' },
      { index: 3, field: 'fecha_nacimiento' }, { index: 4, field: 'estado' },
    ], { format: 'CSV', date1904: false });
    expect(rows[0].errors.map((e) => `${e.field}:${e.code}`)).toEqual([
      'nombre:INVALID_TEXT', 'email:INVALID_EMAIL', 'fecha_nacimiento:INVALID_DATE', 'estado:INVALID_STATUS',
    ]);
    expect(rows[1].errors.map((e) => e.code)).toEqual(['REQUIRED', 'IMPLAUSIBLE_DATE']);
    expect(JSON.stringify(rows.map((r) => r.errors))).not.toMatch(/=1\+1|x@|31\/02|baja/);
  });

  it('fechas ambiguas en un fichero con formato de EE. UU. se interpretan día/mes y se avisa; menores con aviso', () => {
    const now = new Date();
    const minorYear = now.getUTCFullYear() - 10;
    const rows = validateRows([
      { rowNumber: 2, cells: ['Ana', 'Ficticia', '03/04/2001'] },
      { rowNumber: 3, cells: ['Eva', 'Ficticia', '12/25/2001'] },
      { rowNumber: 4, cells: ['Leo', 'Ficticio', `01/01/${minorYear}`] },
    ], [{ index: 0, field: 'nombre' }, { index: 1, field: 'apellidos' }, { index: 2, field: 'fecha_nacimiento' }], { format: 'CSV', date1904: false });
    expect(rows[0].values.birthDate).toBe('2001-04-03');
    expect(rows[0].warnings.map((w) => w.code)).toEqual(['AMBIGUOUS_DATE']);
    expect(rows[1].errors.map((e) => e.code)).toEqual(['INVALID_DATE']);
    expect(rows[2].warnings.map((w) => w.code)).toContain('MINOR');
  });

  it('el informe de errores neutraliza fórmulas', () => {
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx']) expect(neutralizeCsvCell(bad).replace(/^"/, '')).toMatch(/^'/);
    expect(neutralizeCsvCell('texto normal')).toBe('texto normal');
  });
});

describe('Importación: formatos y límites en el servicio', () => {
  const upload = (file: any) => services(prismaMock().prisma).imports.upload('ws-1', therapist, file);

  it('.xls antiguo → pide guardarlo como .xlsx o .csv', async () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]);
    expect(await code(() => upload({ buffer: ole, size: ole.length, originalname: 'antiguo.xls' }))).toBe('LEGACY_XLS');
    // Aunque venga renombrado a .xlsx.
    expect(await code(() => upload({ buffer: ole, size: ole.length, originalname: 'renombrado.xlsx' }))).toBe('LEGACY_XLS');
  });

  it('.ods, .numbers o .xlsm no se admiten', async () => {
    for (const name of ['a.ods', 'a.numbers', 'a.xlsm', 'sin-extension']) {
      expect(await code(() => upload(csvFile('nombre;apellidos\nA;B', name)))).toBe('UNSUPPORTED_FORMAT');
    }
  });

  it('más de 5 MB se rechaza sin procesar', async () => {
    const big = Buffer.alloc(IMPORT_LIMITS.MAX_FILE_BYTES + 1, 0x41);
    expect(await code(() => upload({ buffer: big, size: big.length, originalname: 'grande.csv' }))).toBe('FILE_TOO_LARGE');
  });

  it('un XLSX que no es ZIP, o un ZIP renombrado a .csv, se rechaza', async () => {
    expect(await code(() => upload(csvFile('no soy un zip', 'falso.xlsx')))).toBe('INVALID_XLSX');
    const zip = templateXlsx();
    expect(await code(() => upload({ buffer: zip, size: zip.length, originalname: 'falso.csv' }))).toBe('INVALID_CSV');
  });
});

describe('Importación: HTTP (DTOs con whitelist, CSRF y límite de subida)', () => {
  let app: INestApplication;
  const imports = { upload: jest.fn().mockResolvedValue({ id: 'job-1' }), preview: jest.fn().mockResolvedValue({}) };
  const confirm = { confirm: jest.fn().mockResolvedValue({}) };
  const user = { sub: 'therapist-1', workspaceId: 'ws-1', role: 'THERAPIST', email: 't@example.test' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PatientImportController],
      providers: [
        { provide: PatientImportService, useValue: imports },
        { provide: PatientImportConfirmService, useValue: confirm },
        { provide: PatientImportRevertService, useValue: {} },
        CsrfGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: (ctx: any) => ((ctx.switchToHttp().getRequest().user = user), true) })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(() => app.close());

  const post = (url: string) =>
    request(app.getHttpServer()).post(url).set('Cookie', 'csrf_token=t').set('x-csrf-token', 't');

  it('sin token CSRF no se puede subir', async () => {
    await request(app.getHttpServer()).post('/api/v1/patient-imports').attach('file', Buffer.from('a;b'), 'a.csv').expect(403);
    expect(imports.upload).not.toHaveBeenCalled();
  });

  it('un fichero de más de 5 MB se corta en multer (413) antes de llegar al servicio', async () => {
    await post('/api/v1/patient-imports').attach('file', Buffer.alloc(IMPORT_LIMITS.MAX_FILE_BYTES + 10, 0x41), 'grande.csv').expect(413);
    expect(imports.upload).not.toHaveBeenCalled();
  });

  it('subida válida llega al servicio con workspace y actor del token', async () => {
    await post('/api/v1/patient-imports').attach('file', Buffer.from('nombre;apellidos\nA;B'), 'a.csv').expect(201);
    expect(imports.upload).toHaveBeenCalledWith('ws-1', user, expect.objectContaining({ originalname: 'a.csv' }), 0);
  });

  it('el mapeo no admite campos clínicos ni propiedades extra (therapistId, workspaceId)', async () => {
    await post('/api/v1/patient-imports/job-1/preview').send({ hasHeaderRow: true, columns: [{ index: 0, field: 'consultationReason' }] }).expect(400);
    await post('/api/v1/patient-imports/job-1/preview').send({ hasHeaderRow: true, columns: FULL_MAPPING, therapistId: 'therapist-2' }).expect(400);
    await post('/api/v1/patient-imports/job-1/preview').send({ hasHeaderRow: true, columns: [{ index: 0, field: 'nombre', notes: 'x' }] }).expect(400);
    expect(imports.preview).not.toHaveBeenCalled();
  });

  it('la confirmación no admite therapistId ni acciones desconocidas', async () => {
    await post('/api/v1/patient-imports/job-1/confirm').send({ therapistId: 'therapist-2' }).expect(400);
    await post('/api/v1/patient-imports/job-1/confirm').send({ decisions: [{ row: 2, action: 'OVERWRITE' }] }).expect(400);
    expect(confirm.confirm).not.toHaveBeenCalled();
    await post('/api/v1/patient-imports/job-1/confirm').send({ decisions: [{ row: 2, action: 'CREATE' }] }).expect(200);
    expect(confirm.confirm).toHaveBeenCalledWith('ws-1', user, 'job-1', [expect.objectContaining({ row: 2, action: 'CREATE' })]);
  });
});

describe('Importación: módulo', () => {
  it('resuelve todas sus dependencias (módulo independiente de patients/)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule, PatientImportModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock().prisma)
      .compile();
    expect(moduleRef.get(PatientImportController)).toBeDefined();
    await moduleRef.close();
  });
});
