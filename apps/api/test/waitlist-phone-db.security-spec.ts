import { INestApplication, LoggerService, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import * as cookieParser from 'cookie-parser';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import request = require('supertest');
import { getJwtSecret } from '../src/auth/jwt-secret.util';
import { encryptModelData } from '../src/common/crypto/clinical-crypto';
import { decryptField } from '../src/common/crypto/field-encryption';
import { getCurrentLegalDocuments } from '../src/legal/legal-documents';
import { clearWaitlistPhoneByEmail, setWaitlistPhone } from '../src/waitlist/waitlist-admin';
import { hashWaitlistEmail, issueFormToken } from '../src/waitlist/waitlist-crypto';
import { WaitlistService } from '../src/waitlist/waitlist.service';

/**
 * Teléfono de la lista de espera contra PostgreSQL REAL y con la app COMPLETA (AppModule):
 * cifrado en reposo, panel solo para PLATFORM_ADMIN con MFA, borrado SOLO del teléfono (panel y
 * CLI) con auditoría en PlatformAuditLog, waitlist:set-phone y nada del teléfono en logs ni auditoría.
 *
 * Como los demás *-race: solo con RACE_DATABASE_URL (BD DESECHABLE ya migrada); con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Datos 100 % ficticios.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test del teléfono de la lista de espera no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(180_000);

class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push = (...args: unknown[]) => { this.lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  log = this.push; error = this.push; warn = this.push; debug = this.push; verbose = this.push; fatal = this.push;
}

describeDb('Teléfono de la lista de espera (PostgreSQL real)', () => {
  const run = `telefono-${Date.now()}`;
  const ADMIN_EMAIL = `${run}-admin@example.com`;
  const ADMIN_PASSWORD = 'ClaveFicticiaAdmin-123';
  const V5_EMAIL = `${run}-v5@example.com`;
  const V4_EMAIL = `${run}-v4@example.com`;
  const PHONES = ['+34612000111', '+34612000222', '+34699000333'];
  const logger = new CapturingLogger();
  const previousEnv = { DATABASE_URL: process.env.DATABASE_URL, PLATFORM_ADMIN_EMAILS: process.env.PLATFORM_ADMIN_EMAILS };

  let prisma: PrismaClient;
  let app: INestApplication;
  let jwt: JwtService;
  const ids: Record<string, string> = {};

  const token = (sub: string, workspaceId: string, role: string, mfaEnabled: boolean) =>
    jwt.sign({ sub, email: 'no-se-usa@example.com', workspaceId, role, mfaEnabled, tv: 0 });
  const adminToken = () => token(ids.admin, ids.internalWs, 'OWNER', true);
  const ownerToken = () => token(ids.owner, ids.clientWs, 'OWNER', true);
  const asUser = (t: string) => ({ Authorization: `Bearer ${t}`, Cookie: 'csrf_token=csrf-ficticio', 'x-csrf-token': 'csrf-ficticio' });
  const http = () => request(app.getHttpServer());
  const rowOf = (id: string) => prisma.waitlistEntry.findUniqueOrThrow({ where: { id } });
  const v5 = (email: string, phone: string) => new WaitlistService(prisma as any).submit({
    name: 'Persona Ficticia Telefono', email, phone, situation: 'PRACTICE', privacyAccepted: true,
    privacyPolicyVersion: 'lista-espera-v5', formToken: issueFormToken(Date.now() - 10_000),
  } as any);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    prisma = new PrismaClient({ datasourceUrl: url });
    const passwordHash = await hash(ADMIN_PASSWORD, 4);
    const docs = getCurrentLegalDocuments();
    const member = async (email: string, workspaceId: string) => {
      const user = await prisma.user.create({ data: { email, passwordHash, firstName: 'Usuario', lastName: 'Ficticio', totpEnabled: true } });
      await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role: 'OWNER', isClinician: true } });
      for (const doc of docs) await prisma.termsAcceptance.create({ data: { workspaceId, userId: user.id, documentType: doc.type, version: doc.version, textHash: doc.textHash } });
      return user.id;
    };
    ids.internalWs = (await prisma.workspace.create({ data: { name: `AsePsico interno ficticio ${run}` } })).id;
    ids.clientWs = (await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}` } })).id;
    ids.admin = await member(ADMIN_EMAIL, ids.internalWs);
    ids.owner = await member(`${run}-owner@example.com`, ids.clientWs);

    await v5(V5_EMAIL, '612 000 111');
    ids.v5 = (await prisma.waitlistEntry.findFirstOrThrow({ where: { emailHash: hashWaitlistEmail(V5_EMAIL) } })).id;
    ids.v4 = (await prisma.waitlistEntry.create({ data: {
      ...(encryptModelData('waitlistEntry', { name: 'Persona Ficticia v4', email: V4_EMAIL }) as any),
      emailHash: hashWaitlistEmail(V4_EMAIL), situation: 'SELF_EMPLOYED', privacyPolicyVersion: 'lista-espera-v4', privacyAcceptedAt: new Date(),
    } })).id;

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    jwt = new JwtService({ secret: getJwtSecret(), signOptions: { expiresIn: '15m' } });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    process.env.DATABASE_URL = previousEnv.DATABASE_URL;
    if (previousEnv.PLATFORM_ADMIN_EMAILS === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = previousEnv.PLATFORM_ADMIN_EMAILS;
  });

  it('cifrado en reposo: la columna phone guarda enc: y nunca el número en claro', async () => {
    const raw = await prisma.$queryRaw<Array<{ phone: string | null }>>`SELECT phone FROM "WaitlistEntry" WHERE id = ${ids.v5}`;
    expect(raw[0].phone).toMatch(/^enc:v[12]:/);
    expect(raw[0].phone).not.toContain('612000111');
    expect(decryptField(raw[0].phone)).toBe(PHONES[0]);
    expect((await rowOf(ids.v4)).phone).toBeNull();
  });

  it('panel: PLATFORM_ADMIN con MFA ve el teléfono descifrado y withoutPhone; cualquier otro, 404 sin teléfono', async () => {
    const res = await http().get('/api/v1/admin/waitlist').set(asUser(adminToken())).expect(200);
    const byId = new Map(res.body.entries.map((e: any) => [e.id, e]));
    expect(byId.get(ids.v5)).toMatchObject({ phone: PHONES[0], unreadableFields: [] });
    expect(byId.get(ids.v4)).toMatchObject({ phone: null, unreadableFields: [] });
    expect(res.body.counters.withoutPhone).toBe(await prisma.waitlistEntry.count({ where: { deletedAt: null, phone: null } }));

    for (const t of [ownerToken(), token(ids.admin, ids.internalWs, 'OWNER', false)]) {
      const denied = await http().get('/api/v1/admin/waitlist').set(asUser(t)).expect(404);
      expect(JSON.stringify(denied.body)).not.toContain('612000111');
    }
    await http().get('/api/v1/admin/waitlist').expect(404);
  });

  it('waitlist:set-phone (función): registra el teléfono de una alta v4, cifrado y auditado sin datos', async () => {
    expect(await setWaitlistPhone(prisma, V4_EMAIL, '612 000 222')).toBe('updated');
    const row = await rowOf(ids.v4);
    expect(row.phone).toMatch(/^enc:v[12]:/);
    expect(decryptField(row.phone)).toBe(PHONES[1]);
    expect(row.privacyPolicyVersion).toBe('lista-espera-v4'); // la versión aceptada no cambia
    expect(await setWaitlistPhone(prisma, V4_EMAIL, '900 123 456')).toBe('invalid');
    expect(decryptField((await rowOf(ids.v4)).phone)).toBe(PHONES[1]);
    expect(await setWaitlistPhone(prisma, `${run}-nadie@example.com`, '612 000 222')).toBe('not-found');
    const audit = await prisma.platformAuditLog.findMany({ where: { entityId: ids.v4, action: 'PLATFORM_WAITLIST_PHONE_SET' } });
    expect(audit.map((a) => [a.actorId, a.metadata])).toEqual([[null, { source: 'cli' }]]);
  });

  it('borrar SOLO el teléfono desde el panel: 404 no admin, contraseña, 204, persona sigue en la lista y auditoría', async () => {
    const path = `/api/v1/admin/waitlist/${ids.v5}/phone/delete`;
    // Límite de la ruta: 5/min por IP (compartido con el test de supresión de abajo): 4 aquí y 1 allí.
    await http().post(path).set(asUser(ownerToken())).send({ password: ADMIN_PASSWORD }).expect(404);
    const bad = await http().post(path).set(asUser(adminToken())).send({ password: 'ClaveIncorrecta-000' }).expect(401);
    expect(bad.body).toMatchObject({ code: 'PLATFORM_REAUTH_FAILED' });
    expect((await rowOf(ids.v5)).phone).not.toBeNull();

    const ok = await http().post(path).set(asUser(adminToken())).send({ password: ADMIN_PASSWORD }).expect(204);
    expect(ok.headers['cache-control']).toBe('no-store');
    const row = await rowOf(ids.v5);
    expect(row).toMatchObject({ phone: null, deletedAt: null });
    expect(row.name).not.toBeNull();
    expect(row.email).not.toBeNull();
    expect(row.emailHash).toBe(hashWaitlistEmail(V5_EMAIL));

    await http().post(path).set(asUser(adminToken())).send({ password: ADMIN_PASSWORD }).expect(204); // idempotente

    const audit = await prisma.platformAuditLog.findMany({ where: { actorId: ids.admin, action: { in: ['PLATFORM_REAUTH_FAILED', 'PLATFORM_WAITLIST_PHONE_CLEARED'] } }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => [a.action, a.entityId, a.metadata])).toEqual([
      ['PLATFORM_REAUTH_FAILED', null, { operation: 'waitlist-phone-delete' }],
      ['PLATFORM_WAITLIST_PHONE_CLEARED', ids.v5, { source: 'panel' }],
    ]);
  });

  it('borrar SOLO el teléfono por CLI (función): cleared, luego no-phone; auditoría sin actor', async () => {
    expect(await clearWaitlistPhoneByEmail(prisma, V4_EMAIL)).toBe('cleared');
    expect(await rowOf(ids.v4)).toMatchObject({ phone: null, deletedAt: null });
    expect(await clearWaitlistPhoneByEmail(prisma, V4_EMAIL)).toBe('no-phone');
    expect(await clearWaitlistPhoneByEmail(prisma, `${run}-nadie@example.com`)).toBe('not-found');
    const audit = await prisma.platformAuditLog.findMany({ where: { entityId: ids.v4, action: 'PLATFORM_WAITLIST_PHONE_CLEARED' } });
    expect(audit.map((a) => [a.actorId, a.metadata])).toEqual([[null, { source: 'cli' }]]);
  });

  it('supresión de una alta con teléfono: phone = null; set-phone ya no la encuentra', async () => {
    const email = `${run}-suprimir@example.com`;
    await v5(email, '+34 699 000 333');
    const id = (await prisma.waitlistEntry.findFirstOrThrow({ where: { emailHash: hashWaitlistEmail(email) } })).id;
    await http().post(`/api/v1/admin/waitlist/${id}/delete`).set(asUser(adminToken())).send({ password: ADMIN_PASSWORD }).expect(204);
    expect(await rowOf(id)).toMatchObject({ phone: null, email: null, emailHash: null, deletedAt: expect.any(Date) });
    expect(await setWaitlistPhone(prisma, email, '+34 699 000 333')).toBe('not-found');
    await http().post(`/api/v1/admin/waitlist/${id}/phone/delete`).set(asUser(adminToken())).send({ password: ADMIN_PASSWORD }).expect(404);
  });

  it('CLI waitlist:set-phone de verdad: lee por stdin, no imprime email ni teléfono y rechaza argumentos', () => {
    const cli = (args: string[], input: string) => spawnSync(process.execPath, [require.resolve('tsx/cli'), join(__dirname, '..', 'prisma/scripts/waitlist-set-phone.ts'), ...args], {
      input, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'development' }, timeout: 90_000,
    });
    const set = cli(['--allow-dev-secret'], `${V4_EMAIL}\n+34 612 000 222\n`);
    expect(set.stdout.trim()).toBe('Teléfono guardado (cifrado).');
    const clear = cli(['--clear', '--allow-dev-secret'], `${V4_EMAIL}\n`);
    expect(clear.stdout.trim()).toBe('Teléfono borrado. La persona sigue en la lista de espera.');
    const invalid = cli(['--allow-dev-secret'], `${V4_EMAIL}\n900123456\n`);
    expect(invalid.status).toBe(2);
    const withArgs = cli(['--email', V4_EMAIL, '--allow-dev-secret'], '');
    expect(withArgs.status).toBe(1);
    expect(withArgs.stderr).toContain('Argumentos no admitidos');
    for (const out of [set, clear, invalid, withArgs]) {
      const text = `${out.stdout}\n${out.stderr}`;
      expect(text).not.toContain(V4_EMAIL);
      expect(text).not.toMatch(/612.?000.?222|900123456/);
    }
  });

  it('nada del teléfono (ni del email) en PlatformAuditLog ni en los logs de la app', async () => {
    const audit = JSON.stringify(await prisma.platformAuditLog.findMany({ where: { OR: [{ entityId: { in: [ids.v4, ids.v5] } }, { actorId: ids.admin }] } }));
    const logs = logger.lines.join('\n');
    for (const value of [...PHONES, '612000111', '612 000 111', V5_EMAIL, V4_EMAIL]) {
      expect(audit).not.toContain(value);
      expect(logs).not.toContain(value);
    }
  });
});
