import { INestApplication, LoggerService, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import * as cookieParser from 'cookie-parser';
import { generate } from 'otplib';
import request = require('supertest');
import { getJwtSecret } from '../src/auth/jwt-secret.util';
import { encryptModelData } from '../src/common/crypto/clinical-crypto';
import { getCurrentLegalDocuments } from '../src/legal/legal-documents';
import { issueFormToken, hashWaitlistEmail } from '../src/waitlist/waitlist-crypto';
import { WaitlistService } from '../src/waitlist/waitlist.service';

/**
 * Panel privado de la lista de espera contra PostgreSQL REAL y con la app COMPLETA (AppModule:
 * JwtStrategy, JwtAuthGuard, CsrfGuard, ThrottlerGuard global y endpoints clínicos reales).
 *
 * Como los demás *-race: solo con RACE_DATABASE_URL (BD DESECHABLE ya migrada); con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Datos 100 % ficticios.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test del panel de plataforma no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push = (...args: unknown[]) => { this.lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  log = this.push; error = this.push; warn = this.push; debug = this.push; verbose = this.push; fatal = this.push;
}

describeDb('Panel privado de la lista de espera (PLATFORM_ADMIN, PostgreSQL real)', () => {
  const run = `platform-${Date.now()}`;
  const ADMIN_EMAIL = `${run}-admin@example.com`;
  const ADMIN_PASSWORD = 'ClaveFicticiaAdmin-123';
  const PERSON = { name: `Persona Ficticia ${run}`, email: `${run}-persona@example.com`, tools: `Herramienta ficticia ${run}` };
  const PATIENT_NAME = `PacienteFicticio${run}`;
  const logger = new CapturingLogger();
  const previousEnv = { DATABASE_URL: process.env.DATABASE_URL, PLATFORM_ADMIN_EMAILS: process.env.PLATFORM_ADMIN_EMAILS };

  let prisma: PrismaClient;
  let app: INestApplication;
  let jwt: JwtService;
  const ids: Record<string, string> = {};
  let member: (email: string, role: 'OWNER', workspaceId: string, totpEnabled?: boolean) => Promise<string>;
  const cookiesOf = (res: request.Response) => Object.fromEntries(([] as string[]).concat(res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0].split('=') as [string, string]));

  const token = (sub: string, workspaceId: string, role: string, mfaEnabled: boolean, extra: object = {}) =>
    jwt.sign({ sub, email: 'no-se-usa@example.com', workspaceId, role, mfaEnabled, tv: 0, ...extra });
  const adminToken = () => token(ids.admin, ids.internalWs, 'OWNER', true);
  const ownerToken = () => token(ids.owner, ids.clientWs, 'OWNER', true);
  const http = () => request(app.getHttpServer());
  const asAdmin = (t = adminToken()) => ({ Authorization: `Bearer ${t}`, Cookie: 'csrf_token=csrf-ficticio', 'x-csrf-token': 'csrf-ficticio' });
  const setAdmins = (value: string | undefined) => { if (value === undefined) delete process.env.PLATFORM_ADMIN_EMAILS; else process.env.PLATFORM_ADMIN_EMAILS = value; };
  const platformAudit = () => prisma.platformAuditLog.findMany({ where: { actorId: { in: [ids.admin, ids.owner] } }, orderBy: { createdAt: 'asc' } });

  const entry = (overrides: Record<string, unknown> = {}) => ({
    ...(encryptModelData('waitlistEntry', { name: PERSON.name, email: PERSON.email, tools: PERSON.tools }) as any),
    emailHash: hashWaitlistEmail(`${Math.random()}@example.com`),
    situation: 'PRACTICE',
    professionalsCount: 2,
    source: 'PROFESSIONAL_COLLEGE',
    privacyPolicyVersion: 'lista-espera-v3',
    privacyAcceptedAt: new Date(),
    ...overrides,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    setAdmins(undefined);
    prisma = new PrismaClient({ datasourceUrl: url });
    const passwordHash = await hash(ADMIN_PASSWORD, 4);
    const docs = getCurrentLegalDocuments();
    member = async (email: string, role: 'OWNER', workspaceId: string, totpEnabled = true) => {
      const user = await prisma.user.create({ data: { email, passwordHash, firstName: 'Usuario', lastName: 'Ficticio', totpEnabled } });
      await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role, isClinician: true } });
      for (const doc of docs) await prisma.termsAcceptance.create({ data: { workspaceId, userId: user.id, documentType: doc.type, version: doc.version, textHash: doc.textHash } });
      return user.id;
    };
    ids.internalWs = (await prisma.workspace.create({ data: { name: `AsePsico interno ficticio ${run}` } })).id;
    ids.clientWs = (await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}` } })).id;
    ids.admin = await member(ADMIN_EMAIL, 'OWNER', ids.internalWs);
    ids.owner = await member(`${run}-owner@example.com`, 'OWNER', ids.clientWs);
    ids.patient = (await prisma.patient.create({ data: { workspaceId: ids.clientWs, firstName: PATIENT_NAME, lastName: 'Ficticio', consultationReason: 'Motivo ficticio' } })).id;
    ids.process = (await prisma.clinicalProcess.create({ data: { workspaceId: ids.clientWs, patientId: ids.patient, therapistId: ids.owner, title: 'Proceso ficticio' } })).id;

    ids.active1 = (await prisma.waitlistEntry.create({ data: entry() })).id;
    ids.v2Requested = (await prisma.waitlistEntry.create({ data: entry({ privacyPolicyVersion: 'lista-espera-v2', commercialConsentRequested: true, commercialConsentRequestedAt: new Date(), source: null }) })).id;
    ids.unreadable = (await prisma.waitlistEntry.create({ data: entry({ tools: 'enc:v1:AAAA:BBBB:CCCC' }) })).id;
    ids.suppressed = (await prisma.waitlistEntry.create({ data: { ...entry(), name: null, email: null, emailHash: null, tools: null, deletedAt: new Date() } })).id;

    // La app COMPLETA (import tardío: PrismaService lee DATABASE_URL al construirse).
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // Firma con el secreto de PERSONAL (app.get(JwtService) podría devolver el del portal).
    jwt = new JwtService({ secret: getJwtSecret(), signOptions: { expiresIn: '15m' } });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    process.env.DATABASE_URL = previousEnv.DATABASE_URL;
    setAdmins(previousEnv.PLATFORM_ADMIN_EMAILS);
  });

  afterEach(() => setAdmins(undefined));

  it('variable sin definir o vacía: nadie es PLATFORM_ADMIN (404 también para la cuenta de César)', async () => {
    for (const value of [undefined, '', ' , ']) {
      setAdmins(value);
      await http().get('/api/v1/admin/waitlist').set(asAdmin()).expect(404);
      const me = await http().get('/api/v1/admin/me').set(asAdmin()).expect(200);
      expect(me.body).toEqual({ platformAdmin: false });
    }
  });

  it('PLATFORM_ADMIN con MFA: lista descifrada, contadores, no-store y auditoría sin datos personales', async () => {
    setAdmins(` ${ADMIN_EMAIL.toUpperCase()} ,`);
    expect((await http().get('/api/v1/admin/me').set(asAdmin()).expect(200)).body).toEqual({ platformAdmin: true });
    const res = await http().get('/api/v1/admin/waitlist').set(asAdmin()).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const byId = new Map(res.body.entries.map((e: any) => [e.id, e]));
    expect(byId.get(ids.suppressed)).toBeUndefined();
    expect(byId.get(ids.active1)).toMatchObject({ name: PERSON.name, email: PERSON.email, tools: PERSON.tools, situation: 'PRACTICE', professionalsCount: 2, source: 'PROFESSIONAL_COLLEGE', privacyPolicyVersion: 'lista-espera-v3', commercial: { status: 'NONE', at: null }, unreadableFields: [] });
    expect(byId.get(ids.v2Requested)).toMatchObject({ source: null, commercial: { status: 'REQUESTED_UNCONFIRMED' } });
    expect(byId.get(ids.unreadable)).toMatchObject({ tools: null, unreadableFields: ['tools'], name: PERSON.name });
    expect(Object.keys(byId.get(ids.active1) as object)).not.toContain('emailHash');
    expect(JSON.stringify(res.body)).not.toMatch(/enc:v[12]:/);

    const active = await prisma.waitlistEntry.count({ where: { deletedAt: null } });
    expect(res.body.counters.totalActive).toBe(active);
    expect(res.body.entries).toHaveLength(active);
    expect(res.body.counters.weekly).toHaveLength(8);
    expect(res.body.counters.weekly[7].count).toBeGreaterThanOrEqual(3);
    expect(res.body.counters.bySource.UNSPECIFIED).toBeGreaterThanOrEqual(1);
    expect(res.body.unreadable).toBeGreaterThanOrEqual(1);

    const audit = await prisma.platformAuditLog.findMany({ where: { actorId: ids.admin, action: 'PLATFORM_WAITLIST_VIEWED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ activeCount: active });
  });

  it('cualquier otro usuario: 404 (no 403), sin datos y con PLATFORM_ACCESS_DENIED sin metadata', async () => {
    setAdmins(ADMIN_EMAIL);
    const res = await http().get('/api/v1/admin/waitlist').set(asAdmin(ownerToken())).expect(404);
    expect(JSON.stringify(res.body)).not.toContain(PERSON.email);
    expect((await http().get('/api/v1/admin/me').set(asAdmin(ownerToken())).expect(200)).body).toEqual({ platformAdmin: false });
    const denied = await prisma.platformAuditLog.findMany({ where: { actorId: ids.owner, action: 'PLATFORM_ACCESS_DENIED' } });
    expect(denied).toHaveLength(1);
    expect(denied[0].metadata).toEqual({});
  });

  it('el PLATFORM_ADMIN sin MFA (en la sesión o en la cuenta) recibe 404', async () => {
    setAdmins(ADMIN_EMAIL);
    // El token de una sesión abierta sin segundo factor (rol con MFA obligatorio → JwtAuthGuard 403 → 404 aquí).
    await http().get('/api/v1/admin/waitlist').set(asAdmin(token(ids.admin, ids.internalWs, 'OWNER', false))).expect(404);
    // MFA desactivado en la cuenta con la sesión aún viva: se pierde el acceso en la siguiente petición.
    await prisma.user.update({ where: { id: ids.admin }, data: { totpEnabled: false } });
    try {
      await http().get('/api/v1/admin/waitlist').set(asAdmin()).expect(404);
    } finally {
      await prisma.user.update({ where: { id: ids.admin }, data: { totpEnabled: true } });
    }
  });

  it('sin sesión, token de portal o workspace ajeno: 404', async () => {
    setAdmins(ADMIN_EMAIL);
    await http().get('/api/v1/admin/waitlist').expect(404);
    await http().get('/api/v1/admin/waitlist').set(asAdmin(token(ids.admin, ids.internalWs, 'OWNER', true, { kind: 'portal' }))).expect(404);
    await http().get('/api/v1/admin/waitlist').set(asAdmin(token(ids.admin, ids.clientWs, 'OWNER', true))).expect(404);
    await http().get('/api/v1/admin/me').expect(401);
  });

  it('supresión: exige contraseña, audita sin datos, vacía la fila y permite volver a apuntarse', async () => {
    setAdmins(ADMIN_EMAIL);
    const path = `/api/v1/admin/waitlist/${ids.active1}/delete`;
    // Límite de la ruta: 5/min. Orden: no admin, sin contraseña, contraseña mala, buena, repetida.
    await http().post(path).set({ Authorization: `Bearer ${ownerToken()}` }).send({ password: ADMIN_PASSWORD }).expect(404); // no admin y sin CSRF: 404, no 403
    await http().post(path).set(asAdmin()).send({}).expect(400);
    const bad = await http().post(path).set(asAdmin()).send({ password: 'ClaveIncorrecta-000' }).expect(401);
    expect(bad.body).toMatchObject({ statusCode: 401, code: 'PLATFORM_REAUTH_FAILED' });
    expect(await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: ids.active1 } })).toMatchObject({ deletedAt: null });
    // El fallo cuenta para el bloqueo de la cuenta (mismo contador que el MFA y el cambio de contraseña).
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } })).mfaFailedAttempts).toBe(1);

    const ok = await http().post(path).set(asAdmin()).send({ password: ADMIN_PASSWORD }).expect(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } })).mfaFailedAttempts).toBe(0);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: ids.active1 } })).toMatchObject({
      name: null, email: null, emailHash: null, tools: null, situation: null, source: null, professionalsCount: null, commercialConsentRequested: false, commercialConsent: false,
      deletedAt: expect.any(Date),
    });
    await http().post(path).set(asAdmin()).send({ password: ADMIN_PASSWORD }).expect(404);

    const audit = await prisma.platformAuditLog.findMany({ where: { actorId: ids.admin, action: { in: ['PLATFORM_REAUTH_FAILED', 'PLATFORM_WAITLIST_ENTRY_SUPPRESSED'] } }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => [a.action, a.entityId, a.metadata])).toEqual([
      ['PLATFORM_REAUTH_FAILED', null, { operation: 'waitlist-delete' }],
      ['PLATFORM_WAITLIST_ENTRY_SUPPRESSED', ids.active1, {}],
    ]);

    // La persona puede volver a apuntarse: alta nueva (la suprimida ya no tiene emailHash).
    const email = `${run}-vuelve@example.com`;
    const again = entry({ emailHash: hashWaitlistEmail(email) });
    await prisma.waitlistEntry.create({ data: again });
    await new WaitlistService(prisma as any).submit({ name: 'Persona Ficticia', email, phone: '+34 600 000 004', situation: 'STUDENT', privacyAccepted: true, privacyPolicyVersion: 'lista-espera-v5', formToken: issueFormToken(Date.now() - 10_000) } as any);
    expect(await prisma.waitlistEntry.count({ where: { emailHash: hashWaitlistEmail(email) } })).toBe(1); // repetida: no duplica
    await prisma.waitlistEntry.updateMany({ where: { emailHash: hashWaitlistEmail(email) }, data: { emailHash: null, deletedAt: new Date() } });
    await new WaitlistService(prisma as any).submit({ name: 'Persona Ficticia', email, phone: '+34 600 000 004', situation: 'STUDENT', privacyAccepted: true, privacyPolicyVersion: 'lista-espera-v5', formToken: issueFormToken(Date.now() - 10_000) } as any);
    expect(await prisma.waitlistEntry.count({ where: { emailHash: hashWaitlistEmail(email), deletedAt: null } })).toBe(1);
  });

  it('veto ALTA de Argos: una cuenta con MFA y email homógrafo (ancho completo, ligadura «ﬁ») NO es PLATFORM_ADMIN', async () => {
    const realAdmins = [`${run}-admin@example.com`, `${run}-fiona@example.com`];
    const lookalikes = [`${run}-\uFF41dmin@example.com`, `${run}-\uFB01ona@example.com`, `${run}-admin@example\uFF0Ecom`];
    setAdmins(realAdmins.join(','));
    for (const email of lookalikes) {
      expect(email.normalize('NFKC')).toMatch(/^platform-\d+-(admin|fiona)@example\.com$/); // con NFKC habría coincidido
      const ws = (await prisma.workspace.create({ data: { name: `Consulta homógrafa ficticia ${run}` } })).id;
      const userId = await member(email.trim().toLowerCase(), 'OWNER', ws, true);
      const headers = asAdmin(token(userId, ws, 'OWNER', true));
      await http().get('/api/v1/admin/waitlist').set(headers).expect(404);
      expect((await http().get('/api/v1/admin/me').set(headers).expect(200)).body).toEqual({ platformAdmin: false });
    }
  });

  it('condición de Argos: activar el MFA cierra la sesión sin segundo factor; solo la sesión nueva entra al panel', async () => {
    const email = `${run}-nueva-admin@example.com`;
    const ws = (await prisma.workspace.create({ data: { name: `AsePsico interno ficticio 2 ${run}` } })).id;
    await member(email, 'OWNER', ws, false);
    setAdmins(email);
    const csrf = { 'x-csrf-token': 'csrf-ficticio' };
    const withCookies = (c: Record<string, string>) => ({ ...csrf, Cookie: `access_token=${c.access_token}; refresh_token=${c.refresh_token}; csrf_token=csrf-ficticio` });

    const login = await http().post('/api/v1/auth/login').send({ email, password: ADMIN_PASSWORD }).expect(200);
    expect(login.body.mfaRequired).toBe(false);
    const old = cookiesOf(login);
    await http().get('/api/v1/admin/waitlist').set(withCookies(old)).expect(404); // OWNER sin MFA

    const setup = await http().post('/api/v1/auth/mfa/setup').set(withCookies(old)).expect(201);
    const confirm = await http().post('/api/v1/auth/mfa/confirm').set(withCookies(old)).send({ password: ADMIN_PASSWORD, code: await generate({ secret: setup.body.secret }) }).expect(201);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    const fresh = cookiesOf(confirm);

    // La sesión vieja (abierta sin segundo factor) ya no vale para nada:
    await http().post('/api/v1/auth/refresh').set(withCookies(old)).expect(401); // no se puede renovar
    // Su access token sigue diciendo mfaEnabled=false: fuera de las rutas de configurar el MFA, 403;
    // en esas rutas (las únicas que pasan de ahí) la revalidación de sesión da 401 SESSION_REVOKED.
    expect((await http().get('/api/v1/auth/me').set(withCookies(old)).expect(403)).body.code).toBe('MFA_SETUP_REQUIRED');
    expect((await http().post('/api/v1/auth/mfa/setup').set(withCookies(old)).expect(401)).body.code).toBe('SESSION_REVOKED');
    await http().get('/api/v1/admin/waitlist').set(withCookies(old)).expect(404);
    // La sesión emitida al confirmar (contraseña + TOTP verificados) sí entra.
    await http().get('/api/v1/admin/waitlist').set(withCookies(fresh)).expect(200);
    const renewed = cookiesOf(await http().post('/api/v1/auth/refresh').set(withCookies(fresh)).expect(200));
    await http().get('/api/v1/admin/waitlist').set(withCookies(renewed)).expect(200);
  });

  it('regresión multi-tenant: ser PLATFORM_ADMIN no cambia NADA en los endpoints clínicos', async () => {
    const probes: Array<[string, string, object?]> = [
      ['get', '/api/v1/patients'],
      ['get', `/api/v1/patients/${ids.patient}`],
      ['get', `/api/v1/patients/${ids.patient}/consultation-reason`],
      ['get', `/api/v1/patients/${ids.patient}/history`],
      ['get', `/api/v1/patients/${ids.patient}/timeline`],
      ['get', `/api/v1/clinical-processes?patientId=${ids.patient}`],
      ['get', `/api/v1/clinical-processes/${ids.process}`],
      ['get', `/api/v1/sessions`],
      ['post', `/api/v1/exports/patients/${ids.patient}`, { password: ADMIN_PASSWORD }],
      ['post', '/api/v1/exports/workspace', { password: ADMIN_PASSWORD }],
    ];
    const snapshot = async () => {
      const out: Array<{ status: number; body: unknown }> = [];
      for (const [method, path, body] of probes) {
        const res = await (http() as any)[method](path).set(asAdmin()).send(body ?? undefined);
        // La exportación del workspace lleva su hora y su propia auditoría reciente: se compara lo que importa.
        const comparable = path.endsWith('/exports/workspace') && res.status === 201 ? { patients: res.body.patients, inventory: res.body.inventory } : res.body;
        out.push({ status: res.status, body: comparable });
        expect(JSON.stringify(res.body)).not.toContain(PATIENT_NAME);
        expect(JSON.stringify(res.body)).not.toContain('Motivo ficticio');
      }
      return out;
    };
    setAdmins(undefined);
    const before = await snapshot();
    setAdmins(ADMIN_EMAIL);
    const after = await snapshot();
    expect(after).toEqual(before);
    // El workspace interno está vacío: lo que ve el admin con su rol normal no incluye a nadie de otra consulta.
    expect(before[0].status).toBe(200);
  });

  it('nada personal en la auditoría de plataforma ni en los logs de la aplicación', async () => {
    const audit = JSON.stringify(await platformAudit());
    const logs = logger.lines.join('\n');
    for (const secret of [PERSON.name, PERSON.email, PERSON.tools, hashWaitlistEmail(PERSON.email), ADMIN_PASSWORD, ADMIN_EMAIL]) {
      expect(audit).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    const columns = Object.keys((await prisma.platformAuditLog.findFirstOrThrow({ where: { actorId: ids.admin } })) as object);
    expect(columns).not.toEqual(expect.arrayContaining(['ipAddress']));
    expect(columns).not.toEqual(expect.arrayContaining(['userAgent']));
    expect(columns).not.toEqual(expect.arrayContaining(['workspaceId']));
  });
});
