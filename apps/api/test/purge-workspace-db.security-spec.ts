import { spawnSync } from 'child_process';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { compare, hash } from 'bcryptjs';
import { UnauthorizedException } from '@nestjs/common';
import { assertActiveSession } from '../src/common/auth/active-session';
import { AuthService } from '../src/auth/auth.service';
import { loadSampleData } from '../src/sample-data/sample-data-loader';
import {
  PURGED_USER_FIRST_NAME, PURGED_WORKSPACE_NAME, purgeWorkspace, WorkspacePurgeIncomplete,
} from '../prisma/scripts/demo/workspace-purge';

/**
 * db:purge-workspace contra PostgreSQL REAL (Argos 23/11/2026, punto 4; Lex 24/11/2026, §7.2):
 * dos espacios con datos de ejemplo y datos propios; se borra uno y el otro queda IDÉNTICO en todas
 * las tablas. Se conservan TermsAcceptance y AuditLog; la usuaria no puede entrar; la simulación no
 * escribe; la red de seguridad deshace todo si queda una tabla sin borrar.
 *
 * Como los demás *-db: solo con RACE_DATABASE_URL (BD DESECHABLE ya migrada); con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Datos 100 % ficticios.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de db:purge-workspace no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(180_000);

const PASSWORD = 'contrasena-ficticia-larga-0123';
const CLI = join(__dirname, '..', 'prisma', 'scripts', 'purge-workspace.ts');

describeDb('db:purge-workspace (PostgreSQL real)', () => {
  let prisma: PrismaClient;
  const run = `wspurge-${Date.now()}`;
  let seq = 0;
  let savedEnv: string | undefined;

  beforeAll(() => { prisma = new PrismaClient({ datasourceUrl: url }); savedEnv = process.env.DEMO_ENVIRONMENT; process.env.DEMO_ENVIRONMENT = 'true'; });
  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.DEMO_ENVIRONMENT; else process.env.DEMO_ENVIRONMENT = savedEnv;
    await prisma?.$disconnect();
  });

  /** Espacio con datos de ejemplo (E1), un paciente propio, aceptación, sesión viva, invitaciones y un miembro. */
  async function space() {
    const n = ++seq;
    const ws = await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}-${n}` } });
    const owner = await prisma.user.create({
      data: {
        email: `titular-${run}-${n}@example.test`, passwordHash: await hash(PASSWORD, 4), firstName: 'Titular', lastName: `Ficticia ${n}`,
        totpEnabled: true, totpSecret: 'enc:secreto-ficticio-no-valido', mfaRecoveryCodes: ['hash-ficticio-1'], tokenVersion: 3,
      },
    });
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: owner.id, role: 'OWNER', isClinician: true } });
    const assistant = await prisma.user.create({ data: { email: `recepcion-${run}-${n}@example.test`, passwordHash: 'hash-ficticio', firstName: 'Recepción', lastName: 'Ficticia' } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: assistant.id, role: 'ASSISTANT' } });
    await loadSampleData(prisma, { workspaceId: ws.id, ownerUserId: owner.id, registrationInviteId: `inv-${run}-${n}` });
    const own = await prisma.patient.create({ data: { workspaceId: ws.id, firstName: 'Creado', lastName: 'Por Ella', isDemo: false } });
    await prisma.patientDocument.create({ data: { workspaceId: ws.id, patientId: own.id, title: 'Documento ficticio', type: 'OTHER', storageKey: `private/ficticio-${n}.pdf`, createdById: owner.id } });
    // Factura emitida (no borrador) con su línea y un cobro: en un espacio de prueba también se borran.
    const invoice = await prisma.invoice.create({
      data: { workspaceId: ws.id, patientId: own.id, createdById: owner.id, status: 'ISSUED', sequence: 9000 + n, invoiceNumber: `F-${run}-${n}`, issueDate: new Date(), subtotalCents: 5000, totalCents: 5000,
        lines: { create: [{ description: 'Sesión ficticia', quantity: 1, unitPriceCents: 5000, lineSubtotalCents: 5000, lineTaxCents: 0, lineTotalCents: 5000 }] } },
    });
    await prisma.payment.create({ data: { workspaceId: ws.id, patientId: own.id, invoiceId: invoice.id, recordedById: owner.id, amountCents: 5000, method: 'CASH', paidAt: new Date() } });
    await prisma.termsAcceptance.create({ data: { workspaceId: ws.id, userId: owner.id, documentType: 'PILOT_TERMS', version: 'demo-ficticia', textHash: 'hash-ficticio', ipAddress: '203.0.113.9', userAgent: 'jest' } });
    await prisma.auditLog.create({ data: { workspaceId: ws.id, actorId: owner.id, action: 'TEST_EVENT', entityType: 'Workspace', entityId: ws.id } });
    await prisma.refreshToken.create({ data: { userId: owner.id, workspaceId: ws.id, tokenHash: `${run}-${n}-${randomBytes(8).toString('hex')}`, family: `${run}-${n}`, expiresAt: new Date(Date.now() + 86_400_000) } });
    await prisma.workspaceInvite.create({ data: { workspaceId: ws.id, email: `invitada-${run}-${n}@example.test`, tokenHash: randomBytes(32).toString('hex'), role: 'THERAPIST', isClinician: true, invitedById: owner.id, expiresAt: new Date(Date.now() + 86_400_000) } });
    await prisma.registrationInvite.create({ data: { tokenHash: randomBytes(32).toString('hex'), email: owner.email, createdBy: 'test', expiresAt: new Date(), usedAt: new Date(), usedByUserId: owner.id, workspaceId: ws.id } });
    return { workspaceId: ws.id, owner, assistant };
  }

  /** Huella de TODAS las filas del espacio, tabla a tabla (incluidas las que cuelgan en cascada). */
  async function fingerprint(workspaceId: string): Promise<Record<string, string>> {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND c.column_name = 'workspaceId' AND t.table_type = 'BASE TABLE' ORDER BY 1`;
    const out: Record<string, string> = {};
    const q = async (label: string, sql: string) => {
      const [{ n, h }] = await prisma.$queryRawUnsafe<{ n: bigint; h: string | null }[]>(sql, workspaceId);
      out[label] = `${n}:${h}`;
    };
    for (const { table_name } of tables) await q(table_name, `SELECT count(*) AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS h FROM "${table_name}" t WHERE "workspaceId" = $1`);
    for (const child of ['ClinicalHistory', 'TherapyGoal', 'TherapeuticTask', 'ClinicalAssessment']) {
      await q(child, `SELECT count(*) AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS h FROM "${child}" t JOIN "Patient" p ON p.id = t."patientId" WHERE p."workspaceId" = $1`);
    }
    await q('InvoiceLine', `SELECT count(*) AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS h FROM "InvoiceLine" t JOIN "Invoice" i ON i.id = t."invoiceId" WHERE i."workspaceId" = $1`);
    await q('Message', `SELECT count(*) AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS h FROM "Message" t JOIN "Conversation" c ON c.id = t."conversationId" WHERE c."workspaceId" = $1`);
    await q('Workspace', `SELECT count(*) AS n, md5(string_agg(t::text, '|')) AS h FROM "Workspace" t WHERE id = $1`);
    await q('Users', `SELECT count(*) AS n, md5(string_agg(u::text, '|' ORDER BY u::text)) AS h FROM "User" u WHERE u.id IN (SELECT "userId" FROM "WorkspaceMember" WHERE "workspaceId" = $1)`);
    return out;
  }

  const purge = (workspaceId: string) => prisma.$transaction((tx) => purgeWorkspace(tx, workspaceId), { maxWait: 15_000, timeout: 120_000 });
  const cli = (args: string[], env: Record<string, string | undefined>) => spawnSync(process.execPath, [require.resolve('tsx/cli'), CLI, ...args], {
    env: { PATH: process.env.PATH, DATABASE_URL: url, ...env }, encoding: 'utf8', timeout: 120_000,
  });

  it('borra el espacio A entero y el B queda idéntico en todas las tablas', async () => {
    const a = await space();
    const b = await space();
    const before = await fingerprint(b.workspaceId);
    expect(Number(before.Patient.split(':')[0])).toBeGreaterThan(1);

    const summary = await purge(a.workspaceId);
    expect(summary.patients).toBeGreaterThan(1);
    expect(summary.usersMinimized).toBe(1); // titular: tiene aceptación y auditoría
    expect(summary.usersDeleted).toBe(1); // recepción: sin evidencia que la nombre
    expect(summary.storageReferences).toBeGreaterThanOrEqual(1);

    // B, intacto.
    expect(await fingerprint(b.workspaceId)).toEqual(before);
    expect(await prisma.user.findUnique({ where: { id: b.owner.id } })).toMatchObject({ firstName: 'Titular', tokenVersion: 3, totpEnabled: true });

    // A: solo quedan TermsAcceptance y AuditLog; nada más con su workspaceId.
    const after = await fingerprint(a.workspaceId);
    for (const [table, value] of Object.entries(after)) {
      if (['AuditLog', 'TermsAcceptance', 'Workspace', 'Users'].includes(table)) continue;
      expect([table, value.split(':')[0]]).toEqual([table, '0']);
    }
    expect(await prisma.termsAcceptance.count({ where: { workspaceId: a.workspaceId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { workspaceId: a.workspaceId, action: 'TEST_EVENT' } })).toBe(1);
    expect(await prisma.registrationInvite.count({ where: { email: a.owner.email } })).toBe(0);

    const ws = await prisma.workspace.findUnique({ where: { id: a.workspaceId } });
    expect(ws?.name).toBe(PURGED_WORKSPACE_NAME);
    expect(ws?.purgedAt).toBeInstanceOf(Date);

    const event = await prisma.auditLog.findFirst({ where: { workspaceId: a.workspaceId, action: 'WORKSPACE_PURGED' } });
    expect(event?.actorId).toBeNull();
    // Solo recuentos: todos los valores son números y no aparece ni el correo ni el nombre.
    expect(Object.values(event?.metadata as Record<string, unknown>).filter((v) => typeof v !== 'number')).toEqual(['db:purge-workspace']);
    expect(JSON.stringify(event?.metadata)).not.toMatch(/example\.test|Ficticia|ficticio-\d\.pdf/);

    // La titular: solo id y correo; sin contraseña ni TOTP; sesiones y membresía fuera.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: a.owner.id } });
    expect(user).toMatchObject({ email: a.owner.email, firstName: PURGED_USER_FIRST_NAME, lastName: '', totpEnabled: false, totpSecret: null, mfaRecoveryCodes: [], tokenVersion: 4 });
    expect(await compare(PASSWORD, user.passwordHash)).toBe(false);
    expect(await prisma.refreshToken.count({ where: { userId: a.owner.id } })).toBe(0);
    expect(await prisma.workspaceMember.count({ where: { userId: a.owner.id } })).toBe(0);
    expect(await prisma.user.count({ where: { id: a.assistant.id } })).toBe(0);

    // No puede iniciar sesión, y un access token anterior deja de valer.
    await expect(new AuthService(prisma as any, {} as any, {} as any).login({ email: a.owner.email, password: PASSWORD } as any, {}))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await expect(assertActiveSession(prisma as any, { sub: a.owner.id, workspaceId: a.workspaceId, tv: 3 })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(assertActiveSession(prisma as any, { sub: a.owner.id, workspaceId: a.workspaceId, tv: 4 })).rejects.toBeInstanceOf(UnauthorizedException);

    // Volver a borrarlo se rechaza.
    await expect(purge(a.workspaceId)).rejects.toThrow('ya está borrado');
  });

  it('CLI: sin DEMO_ENVIRONMENT=true se niega; sin --yes solo simula (no escribe) y no imprime correos ni nombres', async () => {
    const c = await space();
    const before = await fingerprint(c.workspaceId);

    for (const value of [undefined, 'false', 'TRUE']) {
      const refused = cli(['--workspace-id', c.workspaceId, '--yes'], { DEMO_ENVIRONMENT: value });
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain('DEMO_ENVIRONMENT');
    }
    const dry = cli(['--owner-email', c.owner.email], { DEMO_ENVIRONMENT: 'true' });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('SIMULACIÓN');
    expect(dry.stdout + dry.stderr).not.toMatch(/example\.test|Titular|Ficticia|ficticio-\d\.pdf/);
    expect(await fingerprint(c.workspaceId)).toEqual(before);

    const done = cli(['--workspace-id', c.workspaceId, '--yes'], { DEMO_ENVIRONMENT: 'true' });
    expect(done.status).toBe(0);
    expect(done.stdout + done.stderr).not.toMatch(/example\.test|Titular|Ficticia|ficticio-\d\.pdf/);
    expect((await prisma.workspace.findUnique({ where: { id: c.workspaceId } }))?.purgedAt).toBeInstanceOf(Date);
  });

  it('si un usuario del espacio es miembro de otro espacio, no se borra nada', async () => {
    const d = await space();
    const e = await space();
    await prisma.workspaceMember.create({ data: { workspaceId: e.workspaceId, userId: d.assistant.id, role: 'ASSISTANT' } });
    const before = await fingerprint(d.workspaceId);
    await expect(purge(d.workspaceId)).rejects.toThrow('otro espacio');
    expect(await fingerprint(d.workspaceId)).toEqual(before);
  });

  it('red de seguridad: si una tabla con workspaceId se queda sin borrar, se deshace todo', async () => {
    const f = await space();
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "ZzPurgeProbe" ("workspaceId" text NOT NULL)');
    try {
      await prisma.$executeRawUnsafe('INSERT INTO "ZzPurgeProbe" ("workspaceId") VALUES ($1)', f.workspaceId);
      const before = await fingerprint(f.workspaceId);
      await expect(purge(f.workspaceId)).rejects.toBeInstanceOf(WorkspacePurgeIncomplete);
      expect(await fingerprint(f.workspaceId)).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "ZzPurgeProbe"');
    }
  });
});
