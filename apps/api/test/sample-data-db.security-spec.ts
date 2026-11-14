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

  beforeAll(() => { prisma = new PrismaClient({ datasourceUrl: url }); });
  afterAll(async () => { await prisma?.$disconnect(); });

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
});
