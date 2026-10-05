import { ConflictException, HttpException, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { strToU8, zipSync } from 'fflate';
import { decryptFieldStrict } from '../src/common/crypto/field-encryption';
import { IMPORT_LIMITS } from '../src/patient-import/import-limits';
import { isRowDataError } from '../src/patient-import/import-errors';
import { readXlsx } from '../src/patient-import/parsing/xlsx-reader';
import { FULL_MAPPING, actor, csvFile, fakePatientsCsv, prismaMock, services } from './patient-import.fixtures';

// Regresiones de las condiciones de Argos (01/10) sobre feat/importacion-pacientes.
// Datos 100 % ficticios.
const therapist = actor('therapist-1', 'THERAPIST');

const xlsx = (sheetData: string) =>
  Buffer.from(
    zipSync({
      'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="H" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheetData}</sheetData></worksheet>`),
    }),
  );

async function imported(n = 3) {
  const mock = prismaMock();
  const svc = services(mock.prisma);
  const uploaded = await svc.imports.upload('ws-1', therapist, csvFile(fakePatientsCsv(n)));
  await svc.imports.preview('ws-1', therapist, uploaded.id, { hasHeaderRow: true, columns: FULL_MAPPING });
  return { ...mock, svc, id: uploaded.id };
}

describe('Argos 1: memoria al leer XLSX', () => {
  it('límites de descompresión: ≤ 15 MB por parte y ≤ 20 MB en total', () => {
    expect(IMPORT_LIMITS.MAX_XLSX_PART_BYTES).toBeLessThanOrEqual(15 * 1024 * 1024);
    expect(IMPORT_LIMITS.MAX_XLSX_TOTAL_BYTES).toBeLessThanOrEqual(20 * 1024 * 1024);
  });

  it('el XML se recorre sin árbol: ya no se usa ningún parser DOM', () => {
    const reader = readFileSync(join(__dirname, '../src/patient-import/parsing/xlsx-reader.ts'), 'utf8');
    expect(reader).not.toMatch(/fast-xml-parser|XMLParser|DOMParser/);
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    expect(pkg.dependencies['fast-xml-parser']).toBeUndefined();
  });

  it('XML patológico (miles de etiquetas sin cerrar o anidadas) se resuelve en tiempo lineal', () => {
    const cases = [
      `<row r="1">${'</x'.repeat(200_000)}${'<c'.repeat(200_000)}</row>`,
      `<row r="1">${'<c r="A1"><v>'.repeat(100_000)}</row>`,
      `${'<row r="1">'.repeat(100_000)}`,
    ];
    for (const sheetData of cases) {
      const started = Date.now();
      try {
        readXlsx(xlsx(sheetData));
      } catch {
        // rechazarlo también vale; lo que se comprueba es que no se cuelga
      }
      expect(Date.now() - started).toBeLessThan(3000);
    }
    // Etiqueta sin cerrar → fichero no válido, sin recorrer el resto.
    expect(() => readXlsx(xlsx('<row r="1"><c r="A1"><v>1</v>'))).toThrow(expect.objectContaining({ code: 'INVALID_XLSX' }));
  });

  it('acepta prefijos de espacio de nombres y texto enriquecido, ignorando la fonética', () => {
    const sheet = readXlsx(
      xlsx('<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:r><x:t>Ana</x:t></x:r><x:rPh><x:t>FONETICA</x:t></x:rPh><x:r><x:t xml:space="preserve"> María</x:t></x:r></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>Pérez &amp; Ficticia &#241;</x:t></x:is></x:c></x:row>'),
    );
    expect(sheet.rows[0].cells).toEqual(['Ana María', 'Pérez & Ficticia ñ']);
  });

  it('una sola subida a la vez por consulta: la concurrente recibe 429 y el bloqueo se libera', async () => {
    const { prisma } = prismaMock();
    const svc = services(prisma);
    const first = svc.imports.upload('ws-1', therapist, csvFile(fakePatientsCsv(2)));
    const second = svc.imports.upload('ws-1', actor('therapist-2', 'THERAPIST'), csvFile(fakePatientsCsv(2)));
    const other = svc.imports.upload('ws-2', actor('therapist-9', 'THERAPIST', 'ws-2'), csvFile(fakePatientsCsv(2)));
    await expect(first).resolves.toEqual(expect.objectContaining({ format: 'CSV' }));
    await expect(second).rejects.toEqual(expect.any(HttpException));
    await expect(second.catch((e) => e.getStatus())).resolves.toBe(429);
    await expect(other).resolves.toEqual(expect.objectContaining({ format: 'CSV' }));
    // Liberado, también tras un error.
    await expect(svc.imports.upload('ws-1', therapist, csvFile('x', 'a.ods'))).rejects.toBeDefined();
    await expect(svc.imports.upload('ws-1', therapist, csvFile(fakePatientsCsv(1)))).resolves.toBeDefined();
  });
});

describe('Argos 2: minimización del fichero temporal', () => {
  it('"Obs." y "Seguimiento" se reconocen como clínicas', async () => {
    const { prisma } = prismaMock();
    const uploaded = await services(prisma).imports.upload('ws-1', therapist, csvFile('Nombre;Apellidos;Obs.;Seguimiento\r\nAna;Ficticia;a;b'));
    expect(uploaded.columns.filter((c) => c.clinical).map((c) => c.label)).toEqual(['Obs.', 'Seguimiento']);
  });

  it('tras la vista previa solo quedan cifradas las columnas asignadas; las demás no se pueden recuperar', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const csv = fakePatientsCsv(2, 'Otros', 'Texto libre ficticio XYZ');
    const uploaded = await svc.imports.upload('ws-1', therapist, csvFile(csv));
    // "Otros" no se reconoce como clínica: al subir se conserva (cifrada)…
    expect(decryptFieldStrict(db.stores.patientImportJob[0].payload)).toContain('XYZ');

    const preview = await svc.imports.preview('ws-1', therapist, uploaded.id, { hasHeaderRow: true, columns: FULL_MAPPING });
    // …y tras la vista previa desaparece: solo quedan las columnas asignadas.
    const stored = decryptFieldStrict(db.stores.patientImportJob[0].payload);
    expect(stored).not.toContain('XYZ');
    expect(stored).not.toContain('Otros');
    expect(stored).toContain('paciente001@example.test');
    expect(preview.columns.find((c) => c.index === 6)).toEqual(expect.objectContaining({ discarded: true, field: 'NO_IMPORTAR' }));

    await expect(
      svc.imports.preview('ws-1', therapist, uploaded.id, { hasHeaderRow: true, columns: [...FULL_MAPPING, { index: 6, field: 'telefono' }].filter((c) => c.index !== 3) }),
    ).rejects.toThrow(/se descartó/);
  });

  it('fichero sin cabecera: las columnas no asignadas se borran también de la primera fila', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const uploaded = await svc.imports.upload('ws-1', therapist, csvFile('Ana;Ficticia;Nota libre ABC\r\nEva;Ficticia;Otra nota DEF'));
    await svc.imports.preview('ws-1', therapist, uploaded.id, {
      hasHeaderRow: false,
      columns: [{ index: 0, field: 'nombre' }, { index: 1, field: 'apellidos' }],
    });
    const stored = decryptFieldStrict(db.stores.patientImportJob[0].payload);
    expect(stored).not.toMatch(/ABC|DEF|Nota/);
    expect(stored).toContain('Eva');
  });
});

describe('Argos 3: deshacer con compare-and-set', () => {
  it('dos deshacer simultáneos: uno gana, el otro 409, y el estado queda coherente', async () => {
    const { db, svc, id } = await imported();
    await svc.confirm.confirm('ws-1', therapist, id, []);
    const results = await Promise.allSettled([svc.revert.revert('ws-1', therapist, id), svc.revert.revert('ws-1', therapist, id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(db.stores.patientImportJob[0]).toEqual(expect.objectContaining({ status: 'REVERTED', revertedCount: 3 }));
    expect(db.stores.patient).toHaveLength(0);
    expect(db.stores.auditLog.filter((a) => a.action === 'PATIENT_IMPORT_BATCH_REVERTED')).toHaveLength(1);
  });

  it('deshacer mientras se reintenta un PARTIAL: solo uno entra, sin estado incoherente', async () => {
    const { db, svc, id, failOn } = await imported(150);
    Object.assign(failOn, { model: 'clinicalProcess', op: 'create', nth: 110, calls: 0 });
    const partial = await svc.confirm.confirm('ws-1', therapist, id, []);
    expect(partial.status).toBe('PARTIAL');
    failOn.model = undefined;

    const [retry, revert] = await Promise.allSettled([
      svc.confirm.confirm('ws-1', therapist, id, []),
      svc.revert.revert('ws-1', therapist, id),
    ]);
    const winners = [retry, revert].filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const loser = [retry, revert].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ConflictException);

    const job = db.stores.patientImportJob[0];
    expect(['COMPLETED', 'REVERTED']).toContain(job.status);
    // Coherencia: cada paciente del lote tiene su ítem y su proceso; nada huérfano.
    expect(db.stores.patientImportItem).toHaveLength(db.stores.patient.length);
    expect(db.stores.clinicalProcess).toHaveLength(db.stores.patient.length);
    expect(job.createdCount - job.revertedCount).toBe(db.stores.patient.length);
  });

  it('un deshacer en curso (REVERTING) bloquea otro deshacer y la confirmación', async () => {
    const { db, svc, id } = await imported();
    await svc.confirm.confirm('ws-1', therapist, id, []);
    db.stores.patientImportJob[0].status = 'REVERTING';
    db.stores.patientImportJob[0].updatedAt = new Date();
    await expect(svc.revert.revert('ws-1', therapist, id)).rejects.toThrow(/ya se está deshaciendo/);
    await expect(svc.confirm.confirm('ws-1', therapist, id, [])).rejects.toBeInstanceOf(ConflictException);
    expect(db.stores.patient).toHaveLength(3);
  });

  it('si un bloque del deshacer falla, el lote vuelve a su estado y se puede reintentar', async () => {
    const { db, svc, id, failOn } = await imported();
    await svc.confirm.confirm('ws-1', therapist, id, []);
    Object.assign(failOn, { model: 'patient', op: 'deleteMany', nth: 2, calls: 0 });
    await expect(svc.revert.revert('ws-1', therapist, id)).rejects.toThrow();
    expect(db.stores.patientImportJob[0].status).toBe('COMPLETED');
    expect(db.stores.patient).toHaveLength(3); // el bloque fallido no deja rastro
    failOn.model = undefined;
    const done = await svc.revert.revert('ws-1', therapist, id);
    expect(done.status).toBe('REVERTED');
    expect(db.stores.patient).toHaveLength(0);
  });
});

describe('Argos 5: menores con modo de portal seguro', () => {
  it('un menor se crea con GUARDIAN_ONLY y un adulto con el valor por defecto', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const minorYear = new Date().getUTCFullYear() - 12;
    const csv = `nombre;apellidos;fecha_nacimiento\r\nLeo;Menor Ficticio;01/01/${minorYear}\r\nAna;Adulta Ficticia;01/01/1980`;
    const uploaded = await svc.imports.upload('ws-1', therapist, csvFile(csv));
    const preview = await svc.imports.preview('ws-1', therapist, uploaded.id, {
      hasHeaderRow: true,
      columns: [{ index: 0, field: 'nombre' }, { index: 1, field: 'apellidos' }, { index: 2, field: 'fecha_nacimiento' }],
    });
    expect(preview.rows[0].warnings.map((w) => w.code)).toContain('MINOR');
    await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    const byName = new Map(db.stores.patient.map((p) => [p.firstName, p]));
    expect(byName.get('Leo')!.portalAccessMode).toBe('GUARDIAN_ONLY');
    expect(byName.get('Ana')!.portalAccessMode).toBe('PATIENT_ONLY');
    expect(db.stores.patientPortalAccount).toHaveLength(0);
  });
});

describe('Argos 4: TODO-E1 — OWNER/ADMIN pueden importar HOY', () => {
  // TODO-E1: cuando se fusione feat/e1-acceso-clinico y assertCanImport use el guard central
  // (WorkspaceMember.isClinician), este test DEBE cambiar: un OWNER/ADMIN NO clínico tiene que
  // recibir 403 (spec, apartado 5) y uno clínico seguir pudiendo importar.
  it.each(['OWNER', 'ADMIN'])('TODO-E1: %s puede importar con el criterio de rol actual', async (role) => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const who = actor(`${role.toLowerCase()}-1`, role);
    const uploaded = await svc.imports.upload('ws-1', who, csvFile(fakePatientsCsv(1)));
    await svc.imports.preview('ws-1', who, uploaded.id, { hasHeaderRow: true, columns: FULL_MAPPING });
    const result = await svc.confirm.confirm('ws-1', who, uploaded.id, []);
    expect(result.createdCount).toBe(1);
    expect(db.stores.clinicalProcess[0].therapistId).toBe(who.sub);
  });
});

describe('Argos 7: integridad referencial del esquema', () => {
  const schema = readFileSync(join(__dirname, '../prisma/schema.prisma'), 'utf8');
  const model = (name: string) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf('}', schema.indexOf(`model ${name} {`)));

  it('PatientImportItem.clinicalProcessId tiene FK a ClinicalProcess', () => {
    expect(model('PatientImportItem')).toMatch(/clinicalProcess\s+ClinicalProcess\s+@relation\(fields: \[clinicalProcessId\]/);
  });

  it('suprimir al usuario importador no queda bloqueado: importerId opcional con SetNull', () => {
    expect(model('PatientImportJob')).toMatch(/importerId\s+String\?/);
    expect(model('PatientImportJob')).toMatch(/importer\s+User\?\s+@relation\(fields: \[importerId\], references: \[id\], onDelete: SetNull\)/);
  });
});

describe('Quima: un fallo de datos de una fila no bloquea el lote', () => {
  // Simula lo visto con Postgres real: el motor de Prisma rechaza el valor de UNA fila.
  const dataError = () => Object.assign(new Error('Invalid argument (valor ficticio)'), { name: 'PrismaClientUnknownRequestError' });
  afterEach(() => jest.restoreAllMocks());

  it('la fila culpable se rechaza, el resto del bloque se importa y el lote termina COMPLETED', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { db, prisma, svc, id } = await imported(150);
    const realCreate = prisma.patient.create.getMockImplementation();
    prisma.patient.create.mockImplementation(async (args: any) => {
      if (args.data.firstName === 'Paciente119') throw dataError(); // falla SIEMPRE, también fila a fila
      return realCreate(args);
    });

    const result = await svc.confirm.confirm('ws-1', therapist, id, []);
    expect(result.status).toBe('COMPLETED');
    expect(result.createdCount).toBe(149);
    expect(result.errorCount).toBe(1);
    expect(db.stores.patient).toHaveLength(149);
    expect(db.stores.patient.some((p) => p.firstName === 'Paciente119')).toBe(false);
    expect(db.stores.clinicalProcess).toHaveLength(149);
    expect(db.stores.patientImportItem).toHaveLength(149);
    expect(db.stores.patientImportJob[0].errorReport).toEqual(expect.arrayContaining([{ row: 120, field: 'fila', code: 'ROW_REJECTED' }]));
    // Ni el log ni el informe llevan el valor ni el mensaje del error.
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Paciente|Ficticio|valor ficticio/);
    const csv = (await svc.imports.errorReport('ws-1', therapist, id)).buffer.toString('utf8');
    expect(csv).toContain('120;fila;');
  });

  it('isRowDataError: InvalidArg (error real de Prisma con un surrogate) es de datos; P1001/P2034 no', () => {
    const known = (code: string) => Object.assign(new Error('x'), { name: 'PrismaClientKnownRequestError', code });
    expect(isRowDataError(known('InvalidArg'))).toBe(true);
    expect(isRowDataError(known('P2000'))).toBe(true);
    expect(isRowDataError(known('P1001'))).toBe(false);
    expect(isRowDataError(known('P2034'))).toBe(false);
    expect(isRowDataError(new Error('bug'))).toBe(false);
  });

  it('con el error real (KnownRequestError InvalidArg) la fila se rechaza y el lote termina COMPLETED', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { db, prisma, svc, id } = await imported(150);
    const realCreate = prisma.patient.create.getMockImplementation();
    prisma.patient.create.mockImplementation(async (args: any) => {
      if (args.data.firstName === 'Paciente119') {
        throw Object.assign(new Error('Invalid argument'), { name: 'PrismaClientKnownRequestError', code: 'InvalidArg' });
      }
      return realCreate(args);
    });
    const result = await svc.confirm.confirm('ws-1', therapist, id, []);
    expect(result.status).toBe('COMPLETED');
    expect(result.createdCount).toBe(149);
    expect(result.errorCount).toBe(1);
    expect(db.stores.patientImportJob[0].errorReport).toEqual(expect.arrayContaining([{ row: 120, field: 'fila', code: 'ROW_REJECTED' }]));
  });

  it('un fallo de sistema (conexión) sigue dejando el lote en PARTIAL para reintentar', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, id, failOn } = await imported(150);
    Object.assign(failOn, {
      model: 'patient', op: 'create', nth: 120, calls: 0,
      error: () => Object.assign(new Error('x'), { name: 'PrismaClientKnownRequestError', code: 'P1001' }),
    });
    const result = await svc.confirm.confirm('ws-1', therapist, id, []);
    expect(result.status).toBe('PARTIAL');
    expect(result.errorCount).toBe(0);
  });
});
