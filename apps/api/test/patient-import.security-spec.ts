import { ConflictException, ForbiddenException, GoneException, Logger, NotFoundException } from '@nestjs/common';
import { decryptFieldStrict } from '../src/common/crypto/field-encryption';
import { PatientImportCleanupService } from '../src/patient-import/patient-import-cleanup.service';
import { FULL_MAPPING, actor, csvFile, fakePatientsCsv, prismaMock, services } from './patient-import.fixtures';

// Datos 100 % ficticios.
const therapist = actor('therapist-1', 'THERAPIST');
const otherTherapist = actor('therapist-2', 'THERAPIST');
const assistant = actor('assistant-1', 'ASSISTANT');
const foreignTherapist = actor('therapist-9', 'THERAPIST', 'ws-2');

async function uploadAndPreview(svc: ReturnType<typeof services>, who = therapist, csv = fakePatientsCsv(3)) {
  const uploaded = await svc.imports.upload(who.workspaceId, who, csvFile(csv));
  const preview = await svc.imports.preview(who.workspaceId, who, uploaded.id, { hasHeaderRow: true, columns: FULL_MAPPING });
  return { uploaded, preview };
}

describe('Importación de pacientes: permisos (solo profesional clínico)', () => {
  it('ASSISTANT recibe 403 en todas las operaciones, se audita el intento y no se crea nada', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const calls: Array<() => Promise<unknown>> = [
      () => svc.imports.template(assistant, 'csv'),
      () => svc.imports.upload('ws-1', assistant, csvFile(fakePatientsCsv(1))),
      () => svc.imports.list('ws-1', assistant),
      () => svc.imports.get('ws-1', assistant, 'job-x'),
      () => svc.imports.preview('ws-1', assistant, 'job-x', { hasHeaderRow: true, columns: FULL_MAPPING }),
      () => svc.imports.cancel('ws-1', assistant, 'job-x'),
      () => svc.imports.errorReport('ws-1', assistant, 'job-x'),
      () => svc.confirm.confirm('ws-1', assistant, 'job-x', []),
      () => svc.revert.revert('ws-1', assistant, 'job-x'),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.stores.patientImportJob).toHaveLength(0);
    expect(db.stores.patient).toHaveLength(0);
    const forbidden = db.stores.auditLog.filter((a) => a.action === 'PATIENT_IMPORT_FORBIDDEN');
    expect(forbidden).toHaveLength(calls.length);
    expect(forbidden.every((a) => a.workspaceId === 'ws-1' && a.actorId === 'assistant-1' && a.metadata.role === 'ASSISTANT')).toBe(true);
  });

  it('un rol inesperado (p. ej. token de portal) no pasa', async () => {
    const { prisma } = prismaMock();
    await expect(services(prisma).imports.upload('ws-1', actor('p-1', 'PATIENT'), csvFile(fakePatientsCsv(1)))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('TODO E1 documentado: el criterio de rol vive en un único punto', () => {
    // Cuando se fusione E1, este test debe cambiar: OWNER/ADMIN no clínicos → 403.
    const source = require('fs').readFileSync(require('path').join(__dirname, '../src/patient-import/patient-import-access.ts'), 'utf8');
    expect(source).toContain('TODO(E1');
  });
});

describe('Importación de pacientes: alta, asignación y auditoría', () => {
  it('crea pacientes a nombre del importador con proceso mínimo vacío, sin portal ni emails, y audita sin datos personales', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const { uploaded, preview } = await uploadAndPreview(svc);
    expect(preview.summary).toEqual({ total: 3, valid: 3, errors: 0, duplicates: 0, ignored: 0 });

    const result = await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    expect(result.status).toBe('COMPLETED');
    expect(result.createdCount).toBe(3);

    expect(db.stores.patient).toHaveLength(3);
    for (const patient of db.stores.patient) {
      expect(patient.workspaceId).toBe('ws-1');
      expect(patient.consultationReason ?? null).toBeNull();
    }
    expect(db.stores.clinicalProcess).toHaveLength(3);
    for (const process of db.stores.clinicalProcess) {
      expect(process).toEqual(
        expect.objectContaining({ workspaceId: 'ws-1', therapistId: 'therapist-1', title: 'Proceso importado', status: 'ACTIVE' }),
      );
      expect([process.consultationReason, process.goals, process.internalNotes]).toEqual([null, null, null]);
    }
    expect(db.stores.patientPortalAccount).toHaveLength(0);
    expect(db.stores.notification).toHaveLength(0);
    expect(db.stores.clinicalHistory).toHaveLength(0);
    expect(db.stores.therapyGoal).toHaveLength(0);

    const created = db.stores.auditLog.filter((a) => a.action === 'PATIENT_CREATED');
    expect(created).toHaveLength(3);
    expect(created.every((a) => a.metadata.source === 'IMPORT' && a.metadata.importJobId === uploaded.id)).toBe(true);
    const batch = db.stores.auditLog.filter((a) => a.action === 'PATIENT_IMPORT_BATCH');
    expect(batch).toHaveLength(1);
    expect(batch[0].metadata).toEqual(expect.objectContaining({ status: 'COMPLETED', format: 'CSV', createdCount: 3 }));

    const allAudit = JSON.stringify(db.stores.auditLog);
    expect(allAudit).not.toMatch(/Paciente00|Ficticio|example\.test|pacientes\.csv/);

    // El fichero temporal se borra al terminar.
    expect(db.stores.patientImportJob[0].payload).toBeNull();
  });

  it('los pacientes de "alta" se crean DISCHARGED con proceso CLOSED y fecha de cierre', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const csv = 'nombre;apellidos;estado\r\nPaciente;Antiguo Ficticio;alta';
    const uploaded = await svc.imports.upload('ws-1', therapist, csvFile(csv));
    await svc.imports.preview('ws-1', therapist, uploaded.id, {
      hasHeaderRow: true,
      columns: [{ index: 0, field: 'nombre' }, { index: 1, field: 'apellidos' }, { index: 2, field: 'estado' }],
    });
    await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    expect(db.stores.patient[0].status).toBe('DISCHARGED');
    expect(db.stores.clinicalProcess[0].status).toBe('CLOSED');
    expect(db.stores.clinicalProcess[0].endedAt).toBeInstanceOf(Date);
  });
});

describe('Importación de pacientes: columnas clínicas', () => {
  it('las columnas clínicas no se guardan, se marcan y no se pueden asignar', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const csv = fakePatientsCsv(2, 'Motivo de consulta', 'Texto clinico ficticio XYZ');
    const uploaded = await svc.imports.upload('ws-1', therapist, csvFile(csv));

    const motivo = uploaded.columns.find((c) => c.label === 'Motivo de consulta')!;
    expect(motivo).toEqual(expect.objectContaining({ clinical: true, suggestedField: 'NO_IMPORTAR' }));
    expect(JSON.stringify(uploaded.sampleRows)).not.toContain('XYZ');

    // Ni cifrado llega a guardarse el contenido de la columna clínica.
    const stored = decryptFieldStrict(db.stores.patientImportJob[0].payload);
    expect(stored).not.toContain('XYZ');

    await expect(
      svc.imports.preview('ws-1', therapist, uploaded.id, {
        hasHeaderRow: true,
        columns: [...FULL_MAPPING.filter((c) => c.field !== 'apellidos'), { index: motivo.index, field: 'apellidos' }],
      }),
    ).rejects.toThrow(/información clínica/);
    // Tampoco sin cabecera (la decisión se toma por la cabecera leída al subir).
    await expect(
      svc.imports.preview('ws-1', therapist, uploaded.id, {
        hasHeaderRow: false,
        columns: [{ index: 0, field: 'nombre' }, { index: motivo.index, field: 'apellidos' }],
      }),
    ).rejects.toThrow(/información clínica/);
  });

  it('otras cabeceras clínicas (observaciones, diagnóstico, notas, medicación) se detectan', async () => {
    const { prisma } = prismaMock();
    const svc = services(prisma);
    const csv = 'Nombre;Apellidos;Observaciones;Diagnóstico;Notas;Medicación;Historia clínica\r\nAna;Ficticia;a;b;c;d;e';
    const uploaded = await svc.imports.upload('ws-1', therapist, csvFile(csv));
    expect(uploaded.columns.filter((c) => c.clinical).map((c) => c.label)).toEqual([
      'Observaciones', 'Diagnóstico', 'Notas', 'Medicación', 'Historia clínica',
    ]);
  });
});

describe('Importación de pacientes: aislamiento', () => {
  it('otro psicólogo del workspace y un usuario de otro workspace no ven ni tocan el lote', async () => {
    const { prisma } = prismaMock();
    const svc = services(prisma);
    const { uploaded } = await uploadAndPreview(svc);
    for (const who of [otherTherapist, foreignTherapist]) {
      await expect(svc.imports.get(who.workspaceId, who, uploaded.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.imports.preview(who.workspaceId, who, uploaded.id, { hasHeaderRow: true, columns: FULL_MAPPING }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.confirm.confirm(who.workspaceId, who, uploaded.id, [])).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.imports.cancel(who.workspaceId, who, uploaded.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.imports.errorReport(who.workspaceId, who, uploaded.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.revert.revert(who.workspaceId, who, uploaded.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(await svc.imports.list(who.workspaceId, who)).toEqual([]);
    }
    // Un OWNER tampoco ve lotes ajenos.
    const owner = actor('owner-1', 'OWNER');
    await expect(svc.imports.get('ws-1', owner, uploaded.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('duplicados: solo contra los pacientes del propio importador, nunca de otro psicólogo ni de otro workspace', async () => {
    const seed = {
      patient: [
        { id: 'own-1', workspaceId: 'ws-1', firstName: 'X', lastName: 'Propio', email: 'paciente001@example.test', phone: null, birthDate: null, status: 'ACTIVE' },
        { id: 'other-1', workspaceId: 'ws-1', firstName: 'Y', lastName: 'Ajeno', email: 'paciente002@example.test', phone: null, birthDate: null, status: 'ACTIVE' },
        { id: 'foreign-1', workspaceId: 'ws-2', firstName: 'Z', lastName: 'Ajeno', email: 'paciente003@example.test', phone: null, birthDate: null, status: 'ACTIVE' },
      ],
      clinicalProcess: [
        { id: 'p-own', workspaceId: 'ws-1', patientId: 'own-1', therapistId: 'therapist-1' },
        { id: 'p-other', workspaceId: 'ws-1', patientId: 'other-1', therapistId: 'therapist-2' },
        { id: 'p-foreign', workspaceId: 'ws-2', patientId: 'foreign-1', therapistId: 'therapist-1' },
      ],
    };
    const { prisma } = prismaMock(seed);
    const svc = services(prisma);
    const { preview } = await uploadAndPreview(svc);
    const byRow = new Map(preview.rows.map((r) => [r.rowNumber, r]));
    expect(byRow.get(2)).toEqual(expect.objectContaining({ status: 'DUPLICATE', duplicate: expect.objectContaining({ source: 'EXISTING', rule: 'EMAIL', patientId: 'own-1' }) }));
    // Paciente de otro psicólogo / de otro workspace con el mismo email: ninguna pista.
    expect(byRow.get(3)).toEqual(expect.objectContaining({ status: 'VALID' }));
    expect(byRow.get(3)!.duplicate).toBeUndefined();
    expect(byRow.get(4)).toEqual(expect.objectContaining({ status: 'VALID' }));

    // Misma respuesta que si esos pacientes ajenos no existieran.
    const { prisma: clean } = prismaMock({ patient: [seed.patient[0]], clinicalProcess: [seed.clinicalProcess[0]] });
    const { preview: baseline } = await uploadAndPreview(services(clean));
    expect(preview.rows).toEqual(baseline.rows);
    expect(preview.summary).toEqual(baseline.summary);
  });

  it('la consulta de duplicados filtra por workspace y por procesos del propio importador', async () => {
    const { prisma } = prismaMock();
    await uploadAndPreview(services(prisma));
    const where = prisma.patient.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ workspaceId: 'ws-1', clinicalProcesses: { some: { workspaceId: 'ws-1', therapistId: 'therapist-1' } } });
  });
});

describe('Importación de pacientes: duplicados e idempotencia', () => {
  it('subir y confirmar dos veces el mismo fichero no duplica pacientes', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const first = await uploadAndPreview(svc);
    await svc.confirm.confirm('ws-1', therapist, first.uploaded.id, []);
    expect(db.stores.patient).toHaveLength(3);

    const second = await uploadAndPreview(svc);
    expect(second.preview.summary.duplicates).toBe(3);
    const result = await svc.confirm.confirm('ws-1', therapist, second.uploaded.id, []);
    expect(result.createdCount).toBe(0);
    expect(result.skippedCount).toBe(3);
    expect(db.stores.patient).toHaveLength(3);
  });

  it('una segunda confirmación del mismo lote se rechaza (409) sin crear nada', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const { uploaded } = await uploadAndPreview(svc);
    await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    await expect(svc.confirm.confirm('ws-1', therapist, uploaded.id, [])).rejects.toBeInstanceOf(ConflictException);
    expect(db.stores.patient).toHaveLength(3);
  });

  it('"Completar el existente" solo rellena campos vacíos y nunca sobrescribe', async () => {
    const seed = {
      patient: [
        { id: 'own-1', workspaceId: 'ws-1', firstName: 'Paciente001', lastName: 'Ficticio Prueba', email: 'paciente001@example.test', phone: '+34 611111111', birthDate: null, status: 'ACTIVE' },
      ],
      clinicalProcess: [{ id: 'p-own', workspaceId: 'ws-1', patientId: 'own-1', therapistId: 'therapist-1' }],
    };
    const { prisma, db } = prismaMock(seed);
    const svc = services(prisma);
    const { uploaded, preview } = await uploadAndPreview(svc, therapist, fakePatientsCsv(1));
    expect(preview.rows[0].status).toBe('DUPLICATE');
    const result = await svc.confirm.confirm('ws-1', therapist, uploaded.id, [{ row: 2, action: 'COMPLETE' }]);
    expect(result.completedCount).toBe(1);
    const patient = db.stores.patient.find((p) => p.id === 'own-1')!;
    expect(patient.phone).toBe('+34 611111111'); // no se sobrescribe
    expect(patient.birthDate).toBeInstanceOf(Date); // se rellena
    const audit = db.stores.auditLog.find((a) => a.action === 'PATIENT_UPDATED')!;
    expect(audit.metadata).toEqual({ source: 'IMPORT', importJobId: uploaded.id, filledFields: ['birthDate'] });
  });

  it('las decisiones solo valen para filas que el servidor marcó como duplicado', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const { uploaded } = await uploadAndPreview(svc);
    await expect(svc.confirm.confirm('ws-1', therapist, uploaded.id, [{ row: 2, action: 'COMPLETE' }])).rejects.toThrow(/no es un posible duplicado/);
    expect(db.stores.patient).toHaveLength(0);
  });
});

describe('Importación de pacientes: bloques, fallo a mitad y reintento', () => {
  it('si falla el tercer bloque, los dos primeros quedan completos, el tercero sin rastro, PARTIAL; el reintento completa sin duplicar', async () => {
    const { prisma, db, failOn } = prismaMock();
    const svc = services(prisma);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { uploaded } = await uploadAndPreview(svc, therapist, fakePatientsCsv(250));

    Object.assign(failOn, { model: 'clinicalProcess', op: 'create', nth: 210, calls: 0 });
    const partial = await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    expect(partial.status).toBe('PARTIAL');
    expect(partial.createdCount).toBe(200);
    expect(partial.canRetry).toBe(true);
    expect(db.stores.patient).toHaveLength(200);
    expect(db.stores.clinicalProcess).toHaveLength(200);
    expect(db.stores.patientImportItem).toHaveLength(200);
    expect(db.stores.auditLog.filter((a) => a.action === 'PATIENT_CREATED')).toHaveLength(200);
    // Ningún paciente sin su proceso.
    const withProcess = new Set(db.stores.clinicalProcess.map((p) => p.patientId));
    expect(db.stores.patient.every((p) => withProcess.has(p.id))).toBe(true);
    // Log sin valores de celdas.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toMatch(/Paciente|Ficticio|example\.test/);

    failOn.model = undefined;
    const done = await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    expect(done.status).toBe('COMPLETED');
    expect(done.createdCount).toBe(250);
    expect(db.stores.patient).toHaveLength(250);
    expect(new Set(db.stores.patient.map((p) => p.email)).size).toBe(250);
    warn.mockRestore();
  });
});

describe('Importación de pacientes: deshacer', () => {
  it('deshace solo pacientes del lote sin actividad, dentro de plazo, y lo audita', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const { uploaded } = await uploadAndPreview(svc);
    await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    // Un paciente ajeno al lote que no debe tocarse.
    db.stores.patient.push({ id: 'unrelated', workspaceId: 'ws-1', firstName: 'A', lastName: 'B', status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() });
    const withSession = db.stores.patientImportItem[0];
    db.stores.session.push({ id: 's-1', workspaceId: 'ws-1', patientId: withSession.patientId, therapistId: 'therapist-1' });

    const result = await svc.revert.revert('ws-1', therapist, uploaded.id);
    expect(result.notRevertedRows).toEqual([withSession.rowNumber]);
    expect(result.revertedCount).toBe(2);
    expect(db.stores.patient.map((p) => p.id).sort()).toEqual([withSession.patientId, 'unrelated'].sort());
    expect(db.stores.clinicalProcess).toHaveLength(1);
    expect(db.stores.auditLog.filter((a) => a.action === 'PATIENT_IMPORT_REVERTED')).toHaveLength(2);
    const batch = db.stores.auditLog.find((a) => a.action === 'PATIENT_IMPORT_BATCH_REVERTED')!;
    expect(batch.metadata).toEqual({ reverted: 2, notReverted: 1, remaining: 1 });
  });

  it('un paciente editado después de importar o con contenido en su proceso no se deshace', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const { uploaded } = await uploadAndPreview(svc);
    await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    const [a, b] = db.stores.patientImportItem;
    const pa = db.stores.patient.find((p) => p.id === a.patientId)!;
    pa.updatedAt = new Date(pa.createdAt.getTime() + 60_000);
    const pb = db.stores.clinicalProcess.find((p) => p.id === b.clinicalProcessId)!;
    pb.internalNotes = 'enc:v1:ficticio';
    const result = await svc.revert.revert('ws-1', therapist, uploaded.id);
    expect(result.notRevertedRows.sort()).toEqual([a.rowNumber, b.rowNumber].sort());
    expect(result.revertedCount).toBe(1);
  });

  it('pasados 7 días no se puede deshacer', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const { uploaded } = await uploadAndPreview(svc);
    await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    db.stores.patientImportJob[0].revertibleUntil = new Date(Date.now() - 1000);
    await expect(svc.revert.revert('ws-1', therapist, uploaded.id)).rejects.toThrow(/7 días/);
    expect(db.stores.patient).toHaveLength(3);
  });

  it('otro psicólogo no puede deshacer el lote', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const { uploaded } = await uploadAndPreview(svc);
    await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    await expect(svc.revert.revert('ws-1', otherTherapist, uploaded.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.stores.patient).toHaveLength(3);
  });

  it('todas las escrituras del deshacer van acotadas por workspaceId', async () => {
    const { prisma } = prismaMock();
    const svc = services(prisma);
    const { uploaded } = await uploadAndPreview(svc);
    await svc.confirm.confirm('ws-1', therapist, uploaded.id, []);
    await svc.revert.revert('ws-1', therapist, uploaded.id);
    for (const modelName of ['patient', 'clinicalProcess', 'patientImportItem', 'patientImportJob']) {
      for (const [args] of [...prisma[modelName].deleteMany.mock.calls, ...prisma[modelName].updateMany.mock.calls]) {
        expect(args.where.workspaceId).toBe('ws-1');
      }
    }
  });
});

describe('Importación de pacientes: fichero temporal', () => {
  it('se guarda cifrado y ligado a workspace e importador', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    await svc.imports.upload('ws-1', therapist, csvFile(fakePatientsCsv(2)));
    const job = db.stores.patientImportJob[0];
    expect(job).toEqual(expect.objectContaining({ workspaceId: 'ws-1', importerId: 'therapist-1' }));
    expect(job.payload).toMatch(/^enc:v[12]:/);
    expect(job.payload).not.toContain('Paciente001');
    expect(job.payloadExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
  });

  it('pasadas 24 h responde 410 y lo borra; la limpieza periódica borra los que nadie tocó', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const a = await svc.imports.upload('ws-1', therapist, csvFile(fakePatientsCsv(2)));
    await svc.imports.upload('ws-1', therapist, csvFile(fakePatientsCsv(2)));
    for (const job of db.stores.patientImportJob) job.payloadExpiresAt = new Date(Date.now() - 1000);

    await expect(svc.imports.preview('ws-1', therapist, a.id, { hasHeaderRow: true, columns: FULL_MAPPING })).rejects.toBeInstanceOf(GoneException);
    expect(db.stores.patientImportJob[0]).toEqual(expect.objectContaining({ payload: null, status: 'EXPIRED' }));

    const cleanup = new PatientImportCleanupService(prisma);
    await cleanup.purgeExpired();
    expect(db.stores.patientImportJob.every((j) => j.payload === null)).toBe(true);
    expect(db.stores.patientImportJob.every((j) => j.status === 'EXPIRED')).toBe(true);
  });

  it('cancelar borra el fichero y no crea ningún paciente', async () => {
    const { prisma, db } = prismaMock();
    const svc = services(prisma);
    const { uploaded } = await uploadAndPreview(svc);
    const cancelled = await svc.imports.cancel('ws-1', therapist, uploaded.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(db.stores.patientImportJob[0].payload).toBeNull();
    expect(db.stores.patient).toHaveLength(0);
    await expect(svc.confirm.confirm('ws-1', therapist, uploaded.id, [])).rejects.toBeInstanceOf(ConflictException);
  });

  it('el informe de errores tiene fila, columna y motivo, sin datos de la fila', async () => {
    const { prisma } = prismaMock();
    const svc = services(prisma);
    const csv = 'nombre;apellidos;email\r\n=CMD+1;Ficticio;malo@example.test\r\nAna;Ficticia;no-es-email';
    const uploaded = await svc.imports.upload('ws-1', therapist, csvFile(csv));
    const preview = await svc.imports.preview('ws-1', therapist, uploaded.id, {
      hasHeaderRow: true,
      columns: [{ index: 0, field: 'nombre' }, { index: 1, field: 'apellidos' }, { index: 2, field: 'email' }],
    });
    expect(preview.summary.errors).toBe(2);
    const report = (await svc.imports.errorReport('ws-1', therapist, uploaded.id)).buffer.toString('utf8');
    expect(report).toContain('fila;columna;motivo');
    expect(report).toContain('2;nombre;Contiene caracteres no permitidos');
    expect(report).toContain('3;email;Email no válido');
    expect(report).not.toMatch(/CMD|Ana|Ficticia|no-es-email|malo@/);
  });
});
