import { PrismaClient } from '@prisma/client';
import { compare } from 'bcryptjs';
import { SAMPLE_PATIENTS } from '../src/sample-data/demo-dataset';
import { loadSampleData } from '../src/sample-data/sample-data-loader';
import { DemoRefusal } from '../src/sample-data/sample-data-purge';
import { SampleDataService } from '../src/sample-data/sample-data.service';

/**
 * E1 · Datos de ejemplo contra PostgreSQL REAL: carga idempotente, aislamiento entre espacios,
 * rollback si el espacio ya tiene pacientes y borrado que solo afecta a los datos de ejemplo.
 *
 * Como los demás *-db: solo con RACE_DATABASE_URL (BD DESECHABLE ya migrada); con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Datos 100 % ficticios.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de datos de ejemplo no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

describeDb('E1 · datos de ejemplo (PostgreSQL real)', () => {
  let prisma: PrismaClient;
  const run = `sample-${Date.now()}`;
  let seq = 0;

  let savedEnv: string | undefined;
  beforeAll(() => { prisma = new PrismaClient({ datasourceUrl: url }); savedEnv = process.env.DEMO_ENVIRONMENT; process.env.DEMO_ENVIRONMENT = 'true'; });
  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.DEMO_ENVIRONMENT; else process.env.DEMO_ENVIRONMENT = savedEnv;
    await prisma?.$disconnect();
  });

  async function space(isClinician = false) {
    const n = ++seq;
    const ws = await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}-${n}` } });
    const user = await prisma.user.create({ data: { email: `titular-${run}-${n}@example.test`, passwordHash: 'hash-ficticio', firstName: 'Titular', lastName: 'Ficticio' } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: 'OWNER', isClinician } });
    const actor = { sub: user.id, workspaceId: ws.id, role: 'OWNER', email: user.email } as any;
    return { workspaceId: ws.id, ownerUserId: user.id, actor };
  }

  it('carga una vez (idempotente), solo en su espacio, con citas hoy y una tarea por revisar', async () => {
    const a = await space();
    const b = await space(true);
    const first = await loadSampleData(prisma, { workspaceId: a.workspaceId, ownerUserId: a.ownerUserId, registrationInviteId: 'inv-ficticia' });
    expect(first.loaded).toBe(true);
    const again = await loadSampleData(prisma, { workspaceId: a.workspaceId, ownerUserId: a.ownerUserId, registrationInviteId: 'inv-ficticia' });
    expect(again).toEqual({ loaded: false, reason: 'ALREADY_LOADED' });

    expect(await prisma.patient.count({ where: { workspaceId: a.workspaceId, isDemo: true } })).toBe(SAMPLE_PATIENTS.length);
    expect(await prisma.patient.count({ where: { workspaceId: a.workspaceId, isDemo: false } })).toBe(0);
    expect(await prisma.patient.count({ where: { workspaceId: b.workspaceId } })).toBe(0);
    expect(await prisma.patientPortalAccount.count({ where: { workspaceId: a.workspaceId } })).toBe(1);

    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    expect(await prisma.session.count({ where: { workspaceId: a.workspaceId, therapistId: a.ownerUserId, startsAt: { gte: start, lte: end } } })).toBeGreaterThanOrEqual(1);
    expect(await prisma.therapeuticTask.count({ where: { status: 'SUBMITTED', patient: { workspaceId: a.workspaceId, clinicalProcesses: { some: { therapistId: a.ownerUserId, status: 'ACTIVE' } } } } })).toBeGreaterThanOrEqual(1);
    expect((await prisma.workspaceMember.findFirst({ where: { workspaceId: a.workspaceId, userId: a.ownerUserId } }))?.isClinician).toBe(true);
    expect(await prisma.auditLog.count({ where: { workspaceId: a.workspaceId, action: 'SAMPLE_DATA_LOADED' } })).toBe(1);
  });

  it('con un paciente real en el espacio se niega y no deja nada (ni la marca de carga)', async () => {
    const c = await space(true);
    await prisma.patient.create({ data: { workspaceId: c.workspaceId, firstName: 'Real', lastName: 'Ficticio' } });
    await expect(loadSampleData(prisma, { workspaceId: c.workspaceId, ownerUserId: c.ownerUserId, registrationInviteId: 'inv-ficticia' })).rejects.toBeInstanceOf(DemoRefusal);
    expect(await prisma.patient.count({ where: { workspaceId: c.workspaceId, isDemo: true } })).toBe(0);
    expect((await prisma.workspace.findUnique({ where: { id: c.workspaceId } }))?.sampleDataLoadedAt).toBeNull();
  });

  it('acceso del paciente de prueba y borrado: solo datos de ejemplo de ESTE espacio', async () => {
    const a = await space(true);
    const b = await space(true);
    await loadSampleData(prisma, { workspaceId: a.workspaceId, ownerUserId: a.ownerUserId, registrationInviteId: 'inv-a' });
    await loadSampleData(prisma, { workspaceId: b.workspaceId, ownerUserId: b.ownerUserId, registrationInviteId: 'inv-b' });
    const real = await prisma.patient.create({ data: { workspaceId: a.workspaceId, firstName: 'Creado', lastName: 'Ficticio' } });
    const service = new SampleDataService(prisma as any);

    const access = await service.issuePortalAccess(a.workspaceId, a.actor, {});
    const account = await prisma.patientPortalAccount.findFirstOrThrow({ where: { workspaceId: a.workspaceId } });
    expect(await compare(access.temporaryPassword, account.passwordHash)).toBe(true);
    expect(account.mustChangePassword).toBe(true);

    // El titular de A, con un token de B, no puede borrar B (no es miembro de B).
    await expect(service.clear(b.workspaceId, { ...a.actor, workspaceId: b.workspaceId }, {})).rejects.toThrow();

    const result = await service.clear(a.workspaceId, a.actor, {});
    expect(result.deleted.patients).toBe(SAMPLE_PATIENTS.length);
    expect(await prisma.patient.count({ where: { workspaceId: a.workspaceId, isDemo: true } })).toBe(0);
    expect(await prisma.patient.findUnique({ where: { id: real.id } })).not.toBeNull();
    expect(await prisma.patient.count({ where: { workspaceId: b.workspaceId, isDemo: true } })).toBe(SAMPLE_PATIENTS.length);
    expect(await prisma.auditLog.count({ where: { workspaceId: a.workspaceId, action: 'SAMPLE_DATA_CLEARED', actorId: a.ownerUserId } })).toBe(1);
    expect((await prisma.workspace.findUnique({ where: { id: a.workspaceId } }))?.sampleDataClearedAt).not.toBeNull();
  });

  it('Argos · borrado con tarea enlazada a sesión, nota privada archivada y adjunto: sin fallos de FK ni huérfanos', async () => {
    const a = await space(true);
    await loadSampleData(prisma, { workspaceId: a.workspaceId, ownerUserId: a.ownerUserId, registrationInviteId: 'inv-fk' });
    const patients = await prisma.patient.findMany({ where: { workspaceId: a.workspaceId, isDemo: true }, select: { id: true } });
    const patientIds = patients.map((p) => p.id);
    const proc = await prisma.clinicalProcess.findFirstOrThrow({ where: { workspaceId: a.workspaceId, patientId: { in: patientIds } } });
    const session = await prisma.session.findFirstOrThrow({ where: { workspaceId: a.workspaceId, patientId: proc.patientId } });
    // Tarea enlazada a una sesión (FK SetNull) además de las que ya enlaza el escritor.
    await prisma.therapeuticTask.create({ data: { patientId: proc.patientId, sessionId: session.id, title: 'enc:ficticio', status: 'PENDING' } as any });
    expect(await prisma.therapeuticTask.count({ where: { patientId: { in: patientIds }, sessionId: { not: null } } })).toBeGreaterThanOrEqual(1);
    // Nota privada archivada de un proceso de ejemplo (FK RESTRICT hacia el proceso).
    await prisma.clinicalProcessPrivateNote.create({ data: { workspaceId: a.workspaceId, processId: proc.id, authorId: a.ownerUserId, notes: 'enc:ficticio' } });
    // Mensaje con adjunto de un paciente de ejemplo.
    const conversation = await prisma.conversation.findFirst({ where: { workspaceId: a.workspaceId, patientId: { in: patientIds } } })
      ?? await prisma.conversation.create({ data: { workspaceId: a.workspaceId, patientId: proc.patientId, status: 'OPEN' } as any });
    await prisma.message.create({ data: { conversationId: conversation.id, senderType: 'PATIENT', body: 'enc:ficticio', attachmentName: 'hoja-ficticia.png', attachmentKey: `${a.workspaceId}/adjunto-ficticio.png`, mimeType: 'image/png' } as any });
    const conversationIds = (await prisma.conversation.findMany({ where: { patientId: { in: patientIds } }, select: { id: true } })).map((c) => c.id);
    const processIds = (await prisma.clinicalProcess.findMany({ where: { patientId: { in: patientIds } }, select: { id: true } })).map((p) => p.id);

    const result = await new SampleDataService(prisma as any).clear(a.workspaceId, a.actor, {});
    expect(result.deleted.patients).toBe(SAMPLE_PATIENTS.length);

    const leftovers = await Promise.all([
      prisma.patient.count({ where: { id: { in: patientIds } } }),
      prisma.session.count({ where: { patientId: { in: patientIds } } }),
      prisma.clinicalProcess.count({ where: { id: { in: processIds } } }),
      prisma.clinicalProcessPrivateNote.count({ where: { processId: { in: processIds } } }),
      prisma.therapeuticTask.count({ where: { patientId: { in: patientIds } } }),
      prisma.therapyGoal.count({ where: { patientId: { in: patientIds } } }),
      prisma.clinicalAssessment.count({ where: { patientId: { in: patientIds } } }),
      prisma.conversation.count({ where: { id: { in: conversationIds } } }),
      prisma.message.count({ where: { conversationId: { in: conversationIds } } }),
      prisma.patientPortalAccount.count({ where: { patientId: { in: patientIds } } }),
      prisma.clinicalHistory.count({ where: { patientId: { in: patientIds } } }),
    ]);
    expect(leftovers).toEqual(leftovers.map(() => 0));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId: a.workspaceId, action: 'SAMPLE_DATA_CLEARED' } });
    expect((audit.metadata as any).storageObjects).toBe(1);
    expect(JSON.stringify(audit.metadata)).not.toContain('adjunto-ficticio');
  });

  it('Argos · los pacientes de ejemplo de OTRO espacio (y todo lo suyo) quedan intactos tras el borrado', async () => {
    const a = await space(true);
    const b = await space(true);
    await loadSampleData(prisma, { workspaceId: a.workspaceId, ownerUserId: a.ownerUserId, registrationInviteId: 'inv-iso-a' });
    await loadSampleData(prisma, { workspaceId: b.workspaceId, ownerUserId: b.ownerUserId, registrationInviteId: 'inv-iso-b' });
    const snapshot = async () => {
      const ids = (await prisma.patient.findMany({ where: { workspaceId: b.workspaceId, isDemo: true }, select: { id: true }, orderBy: { id: 'asc' } })).map((p) => p.id);
      return {
        ids,
        sessions: await prisma.session.count({ where: { workspaceId: b.workspaceId } }),
        processes: await prisma.clinicalProcess.count({ where: { workspaceId: b.workspaceId } }),
        tasks: await prisma.therapeuticTask.count({ where: { patientId: { in: ids } } }),
        portal: await prisma.patientPortalAccount.count({ where: { workspaceId: b.workspaceId } }),
        messages: await prisma.message.count({ where: { conversation: { workspaceId: b.workspaceId } } }),
        workspace: await prisma.workspace.findUniqueOrThrow({ where: { id: b.workspaceId }, select: { sampleDataLoadedAt: true, sampleDataClearedAt: true } }),
      };
    };
    const before = await snapshot();
    expect(before.ids).toHaveLength(SAMPLE_PATIENTS.length);
    await new SampleDataService(prisma as any).clear(a.workspaceId, a.actor, {});
    expect(await snapshot()).toEqual(before);
    expect(before.workspace.sampleDataClearedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { workspaceId: b.workspaceId, action: 'SAMPLE_DATA_CLEARED' } })).toBe(0);
  });
});
