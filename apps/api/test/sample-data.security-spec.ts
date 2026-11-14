import { ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { compare } from 'bcryptjs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RegistrationService } from '../src/auth/registration.service';
import { hashInviteToken } from '../src/auth/invite-token.util';
import { CsrfGuard } from '../src/common/guards/csrf.guard';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import * as legalDocs from '../src/legal/legal-documents';
import { DEMO_PATIENTS, FICTION_PREFIX, SAMPLE_PATIENTS, SAMPLE_PORTAL_PATIENT } from '../src/sample-data/demo-dataset';
import { ClearSampleDataDto } from '../src/sample-data/dto/clear-sample-data.dto';
import { shouldLoadSampleData } from '../src/sample-data/sample-data-eligibility';
import * as loader from '../src/sample-data/sample-data-loader';
import { DemoRefusal } from '../src/sample-data/sample-data-purge';
import { SampleDataController } from '../src/sample-data/sample-data.controller';
import { SAMPLE_DATA_NOT_PURGEABLE, SAMPLE_PORTAL_PATIENT_NOT_FOUND, SampleDataService } from '../src/sample-data/sample-data.service';
import { fakeRegistrationDb } from './support/fake-registration-db';

/**
 * E1 · Espacio de prueba listo para mirar: carga automática de datos de ejemplo al registrarse en el
 * piloto demo y endpoints del titular (estado, acceso del paciente de prueba, borrado). Datos 100 %
 * ficticios; BD falsa que registra cada llamada (la prueba contra PostgreSQL real está en
 * sample-data-db.security-spec.ts).
 */

const DEMO_DOCS = [{ version: 'demo-1.1' }, { version: 'demo-1.3' }];
const DEMO_ENV = { DEMO_ENVIRONMENT: 'true' } as any;
afterEach(() => jest.restoreAllMocks());

/** Prisma falso: $transaction(fn) ejecuta fn con el mismo proxy y registra modelo.método + args. */
function recordingDb(overrides: Record<string, any> = {}) {
  const calls: { op: string; args: any }[] = [];
  let n = 0;
  const db: any = new Proxy({}, {
    get: (_t, model: string) => {
      if (model === '__calls') return calls;
      if (model === 'then') return undefined;
      if (model === '$transaction') return async (fn: any) => fn(db);
      if (model === '$queryRaw') return overrides.$queryRaw ?? (async () => [{ exists: false }]);
      if (model === '$executeRaw') return async (...args: any[]) => { calls.push({ op: '$executeRaw', args }); return 0; };
      return new Proxy({}, {
        get: (_m, method: string) => async (args: any) => {
          const key = `${model}.${method}`;
          calls.push({ op: key, args });
          if (key in overrides) return typeof overrides[key] === 'function' ? overrides[key](args) : overrides[key];
          if (method === 'count') return 0;
          if (method === 'findMany') return [];
          if (method === 'findFirst' || method === 'findUnique') return null;
          if (method.endsWith('Many')) return { count: 1 };
          return { id: `${model}-${++n}` };
        },
      });
    },
  });
  return db;
}

const writes = (db: any) => db.__calls.filter((c: any) => /\.(create|createMany|update|updateMany|delete|deleteMany|upsert)$|\$executeRaw/.test(c.op));

describe('E1 · ¿cuándo se cargan datos de ejemplo? (nunca fuera del piloto demo)', () => {
  it('solo con las tres condiciones: invitación marcada, DEMO_ENVIRONMENT=true exacto y condiciones demo-*', () => {
    expect(shouldLoadSampleData({ withSampleData: true }, DEMO_DOCS, DEMO_ENV)).toBe(true);
  });

  it.each([undefined, null, false])('invitación sin marca (%j) → no', (flag) => {
    expect(shouldLoadSampleData({ withSampleData: flag as any }, DEMO_DOCS, DEMO_ENV)).toBe(false);
  });

  it.each([undefined, '', 'false', '1', 'TRUE', 'yes', ' true'])('DEMO_ENVIRONMENT=%j → no', (value) => {
    const env = value === undefined ? {} : { DEMO_ENVIRONMENT: value };
    expect(shouldLoadSampleData({ withSampleData: true }, DEMO_DOCS, env as any)).toBe(false);
  });

  it('si alguna condición vigente no es del piloto demo (p. ej. las del piloto real) → no', () => {
    expect(shouldLoadSampleData({ withSampleData: true }, [{ version: 'demo-1.1' }, { version: '1.0' }], DEMO_ENV)).toBe(false);
    expect(shouldLoadSampleData({ withSampleData: true }, [], DEMO_ENV)).toBe(false);
  });

  it('las condiciones vigentes del repo son del piloto demo (si cambian, E1 se apaga solo)', () => {
    expect(legalDocs.getCurrentLegalDocuments().every((d) => d.version.startsWith('demo-'))).toBe(true);
  });

  it('el CLI solo marca la invitación en el entorno demo y permite desmarcarla', () => {
    const cli = readFileSync(join(__dirname, '..', 'prisma', 'scripts', 'create-registration-invite.ts'), 'utf8');
    expect(cli).toMatch(/withSampleData = process\.env\.DEMO_ENVIRONMENT === 'true' && !process\.argv\.includes\('--sin-datos-ejemplo'\)/);
  });
});

describe('E1 · registro: la carga se dispara solo para el titular de una invitación demo', () => {
  const DAY = 86_400_000;
  const TOKEN = 'token-ficticio-de-invitacion-e1-0123456789abcdefgh';
  const EMAIL = 'titular-e1@example.com';
  const dto = () => ({
    firstName: 'Titular', lastName: 'Ficticio', email: EMAIL, password: 'contrasena-ficticia-larga', workspaceName: 'Consulta ficticia',
    inviteToken: TOKEN, acceptedTerms: legalDocs.getCurrentLegalDocuments().map((d) => ({ documentType: d.type, version: d.version, textHash: d.textHash })),
  }) as any;
  const invite = (extra: Record<string, unknown> = {}) => ({
    id: 'inv-e1', tokenHash: hashInviteToken(TOKEN), email: EMAIL, expiresAt: new Date(Date.now() + 14 * DAY),
    createdBy: 'cli', createdAt: new Date(), usedAt: null, revokedAt: null, usedByUserId: null, workspaceId: null, ...extra,
  });
  const service = (prisma: any) => new RegistrationService(prisma, { issueSession: jest.fn(async (u: any, w: string, r: string) => ({ user: { id: u.id }, workspaceId: w, role: r })) } as any);
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.DEMO_ENVIRONMENT; });
  afterEach(() => { if (saved === undefined) delete process.env.DEMO_ENVIRONMENT; else process.env.DEMO_ENVIRONMENT = saved; });

  it('invitación demo en entorno demo → carga una vez, con el espacio y el titular recién creados', async () => {
    process.env.DEMO_ENVIRONMENT = 'true';
    const spy = jest.spyOn(loader, 'loadSampleData').mockResolvedValue({ loaded: false, reason: 'ALREADY_LOADED' });
    const prisma = fakeRegistrationDb({ registrationInvite: [invite({ withSampleData: true })] });
    const result: any = await service(prisma).register(dto(), {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ workspaceId: result.workspaceId, ownerUserId: result.user.id, registrationInviteId: 'inv-e1' });
  });

  it.each([
    ['invitación sin marca', {}, 'true'],
    ['entorno real (DEMO_ENVIRONMENT=false)', { withSampleData: true }, 'false'],
    ['DEMO_ENVIRONMENT sin definir', { withSampleData: true }, undefined],
  ])('%s → no se carga nada', async (_label, extra, env) => {
    if (env === undefined) delete process.env.DEMO_ENVIRONMENT; else process.env.DEMO_ENVIRONMENT = env;
    const spy = jest.spyOn(loader, 'loadSampleData');
    const prisma = fakeRegistrationDb({ registrationInvite: [invite(extra)] });
    await service(prisma).register(dto(), {});
    expect(spy).not.toHaveBeenCalled();
  });

  it('si la carga falla, el registro se completa igual y el log no lleva correo ni detalles', async () => {
    process.env.DEMO_ENVIRONMENT = 'true';
    jest.spyOn(loader, 'loadSampleData').mockRejectedValue(Object.assign(new Error(`fallo con ${EMAIL} y Paciente Demo`), { code: 'P2028' }));
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const prisma = fakeRegistrationDb({ registrationInvite: [invite({ withSampleData: true })] });
    const result: any = await service(prisma).register(dto(), {});
    expect(result.workspaceId).toBeTruthy();
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('P2028');
    expect(line).not.toMatch(/@|Paciente|fallo con/);
  });

  it('el alta de un miembro invitado por el titular nunca carga datos de ejemplo', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'auth', 'registration.service.ts'), 'utf8');
    const member = src.slice(src.indexOf('async registerMember'), src.indexOf('private reject'));
    expect(member).not.toMatch(/SampleData/);
    expect((src.match(/shouldLoadSampleData\(/g) ?? []).length).toBe(1);
  });
});

describe('E1 · el conjunto fijo de datos de ejemplo', () => {
  it('solo pacientes del titular, inventados, y un único paciente de prueba con portal', () => {
    expect(SAMPLE_PATIENTS.length).toBeGreaterThanOrEqual(5);
    for (const p of SAMPLE_PATIENTS) {
      expect(p.clinician).toBe('OWNER');
      expect(DEMO_PATIENTS.some((d) => d.firstName === p.firstName && d.lastName === p.lastName)).toBe(true);
    }
    const portal = SAMPLE_PATIENTS.filter((p) => p.portal);
    expect(portal.map((p) => ({ firstName: p.firstName, lastName: p.lastName }))).toEqual([SAMPLE_PORTAL_PATIENT]);
    for (const p of SAMPLE_PATIENTS.filter((x) => !x.portal)) expect(p.messages).toEqual([]);
  });

  it('citas hoy, tareas pendiente/respondida/revisada (una por revisar con proceso activo), proceso con objetivos', () => {
    expect(SAMPLE_PATIENTS.some((p) => p.processes.some((x) => (x.todaySessions ?? 0) > 0 && x.status === 'ACTIVE'))).toBe(true);
    const statuses = new Set(SAMPLE_PATIENTS.flatMap((p) => p.tasks.map((t) => t.status)));
    for (const s of ['PENDING', 'SUBMITTED', 'COMPLETED']) expect(statuses.has(s as any)).toBe(true);
    // «Mi jornada» solo avisa de tareas entregadas de pacientes con proceso ACTIVO del clínico.
    expect(SAMPLE_PATIENTS.some((p) => p.tasks.some((t) => t.status === 'SUBMITTED') && p.processes.some((x) => x.status === 'ACTIVE'))).toBe(true);
    expect(SAMPLE_PATIENTS.some((p) => p.goals.length > 0 && p.processes.some((x) => x.status === 'ACTIVE' && x.goals.startsWith(FICTION_PREFIX)))).toBe(true);
  });
});

describe('E1 · carga (loadSampleData): idempotente, acotada al espacio y sin secretos', () => {
  const NOW = new Date('2026-11-16T08:00:00Z'); // lunes
  const owner = (extra: Record<string, unknown> = {}) => [{ id: 'm-owner', userId: 'u-owner', isClinician: true, status: 'ACTIVE', ...extra }];
  const input = { workspaceId: 'ws-1', ownerUserId: 'u-owner', registrationInviteId: 'inv-1', now: NOW };

  it('si ya se cargó (compare-and-set sin efecto) no escribe nada más', async () => {
    const db = recordingDb({ 'workspace.updateMany': { count: 0 } });
    await expect(loader.loadSampleData(db, input)).resolves.toEqual({ loaded: false, reason: 'ALREADY_LOADED' });
    expect(writes(db).map((c: any) => c.op)).toEqual(['workspace.updateMany']);
    expect(db.__calls[0].args).toEqual({ where: { id: 'ws-1', sampleDataLoadedAt: null }, data: { sampleDataLoadedAt: NOW } });
  });

  it('se niega (y no crea pacientes) si el espacio ya tiene pacientes reales', async () => {
    const db = recordingDb({ 'workspaceMember.findMany': owner(), 'patient.count': (a: any) => (a.where.isDemo === false && a.where.workspaceId === 'ws-1' ? 1 : 0) });
    await expect(loader.loadSampleData(db, input)).rejects.toBeInstanceOf(DemoRefusal);
    expect(db.__calls.some((c: any) => c.op === 'patient.create')).toBe(false);
  });

  it.each([
    ['sin titular', []],
    ['dos titulares', [...owner(), { id: 'm-2', userId: 'u-2', isClinician: true, status: 'ACTIVE' }]],
    ['titular distinto del que se registra', owner({ userId: 'u-otro' })],
    ['titular dado de baja', owner({ status: 'REMOVED' })],
  ])('%s → se niega', async (_l, members) => {
    const db = recordingDb({ 'workspaceMember.findMany': members });
    await expect(loader.loadSampleData(db, input)).rejects.toBeInstanceOf(DemoRefusal);
    expect(db.__calls.some((c: any) => c.op === 'patient.create')).toBe(false);
  });

  it('todo lo que escribe va al espacio indicado, marcado como ejemplo, con citas hoy y una sola cuenta de portal', async () => {
    const db = recordingDb({ 'workspaceMember.findMany': owner() });
    const result: any = await loader.loadSampleData(db, input);
    expect(result.loaded).toBe(true);
    const created = db.__calls.filter((c: any) => c.op.endsWith('.create')).map((c: any) => ({ model: c.op.split('.')[0], data: c.args.data }));
    for (const row of created) if ('workspaceId' in row.data) expect(row.data.workspaceId).toBe('ws-1');
    for (const model of ['patient', 'clinicalProcess', 'session', 'conversation', 'patientPortalAccount', 'auditLog']) {
      for (const row of created.filter((r: any) => r.model === model)) expect(row.data.workspaceId).toBe('ws-1');
    }
    const patients = created.filter((r: any) => r.model === 'patient');
    expect(patients).toHaveLength(SAMPLE_PATIENTS.length);
    for (const p of patients) { expect(p.data.isDemo).toBe(true); expect(p.data.email).toMatch(/@example\.test$/); }
    const portal = created.filter((r: any) => r.model === 'patientPortalAccount');
    expect(portal).toHaveLength(1);
    expect(portal[0].data).toMatchObject({ accessorType: 'PATIENT', mustChangePassword: true, isActive: true });
    const today = created.filter((r: any) => r.model === 'session' && r.data.status === 'SCHEDULED' && r.data.startsAt.toDateString() === NOW.toDateString());
    expect(today.length).toBeGreaterThanOrEqual(1);
    const nextWeek = created.filter((r: any) => r.model === 'session' && r.data.startsAt.getTime() > NOW.getTime() + 7 * 86_400_000);
    expect(nextWeek.length).toBeGreaterThanOrEqual(1);
    expect(created.some((r: any) => r.model === 'session' && typeof r.data.notes === 'string' && r.data.notes.startsWith('enc:'))).toBe(true);
    for (const r of created.filter((x: any) => ['clinicalProcess', 'session'].includes(x.model))) expect(r.data.therapistId).toBe('u-owner');
    expect(result.counts.sessions.today).toBeGreaterThanOrEqual(1);
  });

  it('auditoría SAMPLE_DATA_LOADED en la misma transacción, solo recuentos (sin nombres, correos ni contraseñas)', async () => {
    const db = recordingDb({ 'workspaceMember.findMany': owner() });
    await loader.loadSampleData(db, input);
    const audits = db.__calls.filter((c: any) => c.op === 'auditLog.create').map((c: any) => c.args.data);
    expect(audits.map((a: any) => a.action)).toEqual(['SAMPLE_DATA_LOADED']);
    expect(audits[0]).toMatchObject({ workspaceId: 'ws-1', entityId: 'ws-1', actorId: null });
    const json = JSON.stringify(audits[0].metadata);
    expect(json).not.toMatch(/password|Paciente|Demo|example\.test|enc:/i);
    expect(audits[0].metadata.patients).toBe(SAMPLE_PATIENTS.length);
  });

  it('si el titular no era profesional clínico, lo marca (acotado al espacio) y lo audita', async () => {
    const db = recordingDb({ 'workspaceMember.findMany': owner({ isClinician: false }) });
    const result: any = await loader.loadSampleData(db, input);
    expect(result.ownerMadeClinician).toBe(true);
    const update = db.__calls.find((c: any) => c.op === 'workspaceMember.updateMany');
    expect(update.args.where).toEqual({ id: 'm-owner', workspaceId: 'ws-1', role: 'OWNER', isClinician: false });
    expect(db.__calls.filter((c: any) => c.op === 'auditLog.create').map((c: any) => c.args.data.action)).toEqual(['MEMBER_CLINICIAN_CHANGED', 'SAMPLE_DATA_LOADED']);
  });

  it('la contraseña aleatoria del portal se descarta: el cargador no la devuelve ni la registra', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'sample-data', 'sample-data-loader.ts'), 'utf8');
    expect(src).not.toMatch(/console\.|Logger/);
    // El resultado de writeDemoPatient (que trae la credencial) no se asigna a nada.
    expect(src).toMatch(/^\s+await writeDemoPatient\(tx, ctx, spec, index, counts\);$/m);
  });
});

describe('E1 · endpoints del titular: solo OWNER y solo su espacio', () => {
  const owner = { sub: 'u-owner', workspaceId: 'ws-1', role: 'OWNER', email: 'titular@example.com' } as any;
  const membership = (role: string) => ({ 'workspaceMember.findFirst': (a: any) => (a.where.workspaceId === 'ws-1' && a.where.userId === 'u-owner' && a.where.status === 'ACTIVE' ? { role } : null) });

  it('las rutas llevan JwtAuthGuard y CsrfGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SampleDataController)).toEqual([JwtAuthGuard, CsrfGuard]);
  });

  it.each(['ADMIN', 'THERAPIST', 'ASSISTANT'])('%s (según la BD) → 403 en las tres operaciones y no escribe nada', async (role) => {
    const db = recordingDb(membership(role));
    const svc = new SampleDataService(db);
    await expect(svc.status('ws-1', owner)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.issuePortalAccess('ws-1', owner, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.clear('ws-1', owner, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes(db)).toEqual([]);
  });

  it('un token que no es de staff (portal) → 403 sin consultar nada', async () => {
    const db = recordingDb(membership('OWNER'));
    await expect(new SampleDataService(db).clear('ws-1', { ...owner, role: 'PATIENT' }, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.__calls).toEqual([]);
  });

  it('el titular de OTRO espacio no puede tocar este (la pertenencia se comprueba con el workspaceId del token)', async () => {
    const db = recordingDb(membership('OWNER'));
    const outsider = { ...owner, workspaceId: 'ws-2' };
    await expect(new SampleDataService(db).clear('ws-2', outsider, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes(db)).toEqual([]);
  });

  it('borrado: solo pacientes isDemo del espacio, todo filtrado por workspaceId, auditado en la misma transacción', async () => {
    const db = recordingDb({ ...membership('OWNER'), 'patient.findMany': (a: any) => (a.where.workspaceId === 'ws-1' && a.where.isDemo === true ? [{ id: 'p-demo' }] : [{ id: 'p-real' }]) });
    const result = await new SampleDataService(db).clear('ws-1', owner, { ip: '203.0.113.7' });
    expect(result.deleted.patients).toBe(1);
    const patientDelete = db.__calls.find((c: any) => c.op === 'patient.deleteMany');
    expect(patientDelete.args.where).toEqual({ workspaceId: 'ws-1', isDemo: true, id: { in: ['p-demo'] } });
    for (const c of writes(db).filter((x: any) => x.op !== 'auditLog.create')) {
      const where = JSON.stringify(c.args.where ?? {});
      expect(where).toMatch(/"workspaceId":"ws-1"|"id":"ws-1"/);
      expect(where).not.toContain('p-real');
    }
    const audit = db.__calls.find((c: any) => c.op === 'auditLog.create').args.data;
    expect(audit).toMatchObject({ workspaceId: 'ws-1', actorId: 'u-owner', action: 'SAMPLE_DATA_CLEARED', entityId: 'ws-1' });
    expect(db.__calls.find((c: any) => c.op === 'workspace.updateMany').args.where).toEqual({ id: 'ws-1' });
  });

  it('borrado con facturas emitidas de pacientes de ejemplo → 409 SAMPLE_DATA_NOT_PURGEABLE y no borra nada', async () => {
    const db = recordingDb({ ...membership('OWNER'), 'patient.findMany': [{ id: 'p-demo' }], 'invoice.count': (a: any) => (a.where.status ? 1 : 0) });
    const error: any = await new SampleDataService(db).clear('ws-1', owner, {}).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().code).toBe(SAMPLE_DATA_NOT_PURGEABLE);
    expect(writes(db)).toEqual([]);
  });

  it('la confirmación es obligatoria: solo { confirm: true } exacto', async () => {
    for (const body of [{}, { confirm: 'true' }, { confirm: false }, { confirm: 1 }]) {
      expect((await validate(plainToInstance(ClearSampleDataDto, body))).length).toBeGreaterThan(0);
    }
    expect(await validate(plainToInstance(ClearSampleDataDto, { confirm: true }))).toEqual([]);
  });

  it('acceso del paciente de prueba: contraseña nueva una vez, solo su hash en la BD y nada en la auditoría', async () => {
    const patient = { id: 'p-demo', firstName: 'Paciente', lastName: 'Demo', status: 'ACTIVE', portalAccounts: [{ id: 'acc-1', email: 'paciente.demo.abcd@example.test' }] };
    const db = recordingDb({ ...membership('OWNER'), 'patient.findFirst': (a: any) => (a.where.workspaceId === 'ws-1' && a.where.isDemo === true ? patient : null) });
    const result = await new SampleDataService(db).issuePortalAccess('ws-1', owner, {});
    expect(result).toMatchObject({ patientId: 'p-demo', email: 'paciente.demo.abcd@example.test', mustChangePassword: true });
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(20);
    const update = db.__calls.find((c: any) => c.op === 'patientPortalAccount.updateMany').args;
    expect(update.where).toMatchObject({ id: 'acc-1', workspaceId: 'ws-1', patientId: 'p-demo', accessorType: 'PATIENT', patient: { workspaceId: 'ws-1', isDemo: true, deletedAt: null } });
    expect(update.data.passwordHash).not.toContain(result.temporaryPassword);
    expect(await compare(result.temporaryPassword, update.data.passwordHash)).toBe(true);
    expect(update.data.mustChangePassword).toBe(true);
    const audit = db.__calls.find((c: any) => c.op === 'auditLog.create').args.data;
    expect(audit).toMatchObject({ action: 'SAMPLE_PORTAL_ACCESS_ISSUED', workspaceId: 'ws-1', actorId: 'u-owner', entityId: 'acc-1' });
    expect(JSON.stringify(audit)).not.toContain(result.temporaryPassword);
    expect(JSON.stringify(audit)).not.toContain('example.test');
  });

  it('sin paciente de prueba (borrado o de otro espacio) → 404 y no escribe', async () => {
    const db = recordingDb(membership('OWNER'));
    const error: any = await new SampleDataService(db).issuePortalAccess('ws-1', owner, {}).catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.getResponse().code).toBe(SAMPLE_PORTAL_PATIENT_NOT_FOUND);
    expect(writes(db)).toEqual([]);
  });

  it('estado: sin contenido clínico (solo fechas, recuento y nombre inventado del paciente de prueba)', async () => {
    const db = recordingDb({
      ...membership('OWNER'),
      'workspace.findUnique': { sampleDataLoadedAt: new Date('2026-11-14T10:00:00Z'), sampleDataClearedAt: null },
      'patient.count': 7,
      'patient.findFirst': { id: 'p-demo', firstName: 'Paciente', lastName: 'Demo', status: 'ACTIVE', portalAccounts: [{ id: 'acc-1', email: 'x@example.test' }] },
    });
    const status = await new SampleDataService(db).status('ws-1', owner);
    expect(status).toEqual({ loaded: true, loadedAt: '2026-11-14T10:00:00.000Z', clearedAt: null, samplePatients: 7, portalPatient: { patientId: 'p-demo', firstName: 'Paciente', lastName: 'Demo' } });
    expect(db.__calls.find((c: any) => c.op === 'patient.count').args.where).toMatchObject({ workspaceId: 'ws-1', isDemo: true });
  });

  it('las respuestas con credenciales no se cachean y las escrituras tienen límite de frecuencia', () => {
    const proto = SampleDataController.prototype as any;
    for (const handler of ['issuePortalAccess', 'clear']) {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto[handler])).toBe(5);
      expect(Reflect.getMetadata('__headers__', proto[handler])).toEqual(expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }]));
    }
  });
});
