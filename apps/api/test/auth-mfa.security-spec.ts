import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { hash } from 'bcryptjs';
import * as cookieParser from 'cookie-parser';
import { generate } from 'otplib';
import request = require('supertest');
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { MFA_PENDING_TOKEN_MAX_FAILURES, MfaService, mfaLockDurationMs } from '../src/auth/mfa.service';
import { hashRecoveryCodes } from '../src/auth/recovery-codes.util';
import { encryptField } from '../src/common/crypto/field-encryption';
import { CsrfGuard } from '../src/common/guards/csrf.guard';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Endurecimiento del MFA (ticket de Argos):
 *  A. mfa/setup y mfa/confirm no pueden reemplazar un segundo factor ya activo.
 *  B. Cada TOTP se acepta una sola vez (RFC 6238 §5.2); los códigos de recuperación también.
 *  C. Cache-Control: no-store en login y MFA.
 *  D. Auditoría transaccional (rollback si falla) y sin secretos en metadata.
 *  E. Throttle en mfa/*.
 * Seguimiento de Argos:
 *  1. confirm exige la contraseña actual (activación hostil con sesión robada).
 *  2. Límite de intentos de segundo factor por cuenta con espera creciente y anulación del pendingToken.
 *  4. Tolerancia de reloj ±1 paso, segura gracias al anti-replay.
 * Todos los datos son ficticios.
 */

const PASSWORD = 'contrasena-ficticia-123';
const WORKSPACE_ID = 'ws-ficticio-1';
const USER_ID = 'user-ficticio-1';
const EMAIL = 'terapeuta.mfa@example.test';
const CSRF = 'csrf-ficticio';
// Instante fijo a mitad de un paso de 30 s: el test no depende de cruzar un límite de paso.
const BASE_NOW = Date.UTC(2026, 0, 15, 10, 0, 15);

type FakeUser = {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  totpSecret: string | null;
  totpEnabled: boolean;
  totpLastUsedStep: number | null;
  mfaRecoveryCodes: string[];
  mfaFailedAttempts: number;
  mfaLockedUntil: Date | null;
};

/** Prisma en memoria con transacciones de verdad: si el callback lanza, se revierte todo. */
class FakePrisma {
  users = new Map<string, FakeUser>();
  auditLogs: any[] = [];
  refreshTokens: any[] = [];
  failAuditAction: string | null = null;

  user = {
    findUnique: async ({ where, include }: any) => {
      const u = where.id ? this.users.get(where.id) : [...this.users.values()].find((x) => x.email === where.email);
      if (!u) return null;
      const copy: any = structuredClone(u);
      if (include?.memberships) copy.memberships = [{ workspaceId: WORKSPACE_ID, role: 'THERAPIST', userId: u.id }];
      return copy;
    },
    update: async ({ where, data, select }: any) => {
      const u = this.users.get(where.id);
      if (!u) throw new Error('Registro no encontrado');
      for (const [key, value] of Object.entries(data) as [string, any][]) {
        (u as any)[key] = value && typeof value === 'object' && 'increment' in value ? (u as any)[key] + value.increment : structuredClone(value);
      }
      const copy: any = structuredClone(u);
      return select ? Object.fromEntries(Object.keys(select).map((k) => [k, copy[k]])) : copy;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const u of this.users.values()) {
        if (matches(u, where)) {
          Object.assign(u, structuredClone(data));
          count++;
        }
      }
      return { count };
    },
  };

  auditLog = {
    create: async ({ data }: any) => {
      if (this.failAuditAction && data.action === this.failAuditAction) throw new Error('fallo simulado de auditoría');
      this.auditLogs.push(structuredClone(data));
      return data;
    },
  };

  refreshToken = {
    create: async ({ data }: any) => {
      this.refreshTokens.push(data);
      return data;
    },
  };

  /** Advisory locks de transacción (pg_try_advisory_xact_lock). false = simular que no existen. */
  advisoryLocks = true;
  heldLocks = new Set<string>();
  /** Intentos que llegaron a evaluar un código (lock conseguido). */
  lockAcquisitions = 0;

  async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const snapshot = { users: structuredClone([...this.users.entries()]), audit: structuredClone(this.auditLogs) };
    const held: string[] = [];
    const tx = Object.create(this);
    tx.$queryRaw = async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      const key = values.join('|');
      if (this.advisoryLocks && this.heldLocks.has(key)) return [{ acquired: false }];
      if (this.advisoryLocks) {
        this.heldLocks.add(key);
        held.push(key);
      }
      this.lockAcquisitions++;
      return [{ acquired: true }];
    };
    try {
      return await fn(tx);
    } catch (error) {
      this.users = new Map(snapshot.users);
      this.auditLogs = snapshot.audit;
      throw error;
    } finally {
      for (const key of held) this.heldLocks.delete(key);
    }
  }
}

function matches(u: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return (cond as any[]).some((w) => matches(u, w));
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('equals' in cond) return JSON.stringify(u[key]) === JSON.stringify(cond.equals);
      if ('lt' in cond) return u[key] !== null && u[key] < cond.lt;
      throw new Error(`Condición no soportada en el fake: ${key}`);
    }
    return u[key] === cond;
  });
}

let currentActor = { sub: USER_ID, workspaceId: WORKSPACE_ID, role: 'THERAPIST', email: EMAIL };
class TestJwtGuard {
  canActivate(context: ExecutionContext) {
    context.switchToHttp().getRequest().user = currentActor;
    return true;
  }
}

describe('MFA hardening (setup/confirm/disable/login/mfa)', () => {
  let app: INestApplication;
  let db: FakePrisma;
  let now = BASE_NOW;
  let passwordHash: string;

  const code = (secret: string) => generate({ secret });
  const post = (path: string) =>
    request(app.getHttpServer()).post(`/api/v1/auth/${path}`).set('Cookie', `csrf_token=${CSRF}`).set('x-csrf-token', CSRF);
  const user = () => db.users.get(USER_ID)!;
  const actions = () => db.auditLogs.map((a) => a.action);

  async function seedUser(overrides: Partial<FakeUser> = {}) {
    db.users.set(USER_ID, {
      id: USER_ID, email: EMAIL, passwordHash, firstName: 'Ana', lastName: 'Ficticia',
      totpSecret: null, totpEnabled: false, totpLastUsedStep: null, mfaRecoveryCodes: [],
      mfaFailedAttempts: 0, mfaLockedUntil: null,
      ...overrides,
    });
  }

  /** Cuenta con MFA ya activo: devuelve el secreto y los códigos de recuperación en claro. */
  async function seedUserWithMfa(overrides: Partial<FakeUser> = {}) {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const recovery = ['11111-22222', '33333-44444'];
    await seedUser({
      totpSecret: encryptField(secret), totpEnabled: true, mfaRecoveryCodes: await hashRecoveryCodes(recovery),
      ...overrides,
    });
    return { secret, recovery };
  }

  async function pendingToken() {
    const res = await post('login').send({ email: EMAIL, password: PASSWORD }).expect(200);
    expect(res.body.mfaRequired).toBe(true);
    return res.body.pendingToken as string;
  }

  beforeAll(async () => {
    passwordHash = await hash(PASSWORD, 4);
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    db = new FakePrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'secreto-solo-para-tests', signOptions: { expiresIn: '15m' } })],
      controllers: [AuthController],
      providers: [AuthService, MfaService, CsrfGuard, { provide: PrismaService, useFactory: () => db }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtGuard)
      .compile();
    // Sin logger: los 500 provocados a propósito (fallo simulado de auditoría) no ensucian la salida.
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  beforeEach(() => {
    now = BASE_NOW;
    db.users.clear();
    db.auditLogs = [];
    db.refreshTokens = [];
    db.failAuditAction = null;
    db.advisoryLocks = true;
    db.heldLocks.clear();
    db.lockAcquisitions = 0;
    currentActor = { sub: USER_ID, workspaceId: WORKSPACE_ID, role: 'THERAPIST', email: EMAIL };
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  describe('A. no se puede reemplazar un segundo factor activo', () => {
    it('mfa/setup con MFA activo → 400 y la BD queda intacta', async () => {
      await seedUserWithMfa();
      const before = structuredClone(user());
      const res = await post('mfa/setup').expect(400);
      expect(res.body.secret).toBeUndefined();
      expect(user()).toEqual(before);
      expect(user().totpEnabled).toBe(true);
      expect(actions()).toEqual(['MFA_SETUP_REJECTED']);
    });

    it('mfa/confirm con MFA activo → 400 y no se regeneran los códigos de recuperación', async () => {
      const { secret } = await seedUserWithMfa();
      const before = structuredClone(user());
      await post('mfa/confirm').send({ password: PASSWORD, code: await code(secret) }).expect(400);
      expect(user()).toEqual(before);
      expect(actions()).toEqual(['MFA_CONFIRM_REJECTED']);
    });

    it('setup sin MFA reutiliza el secreto pendiente (doble clic / varias pestañas)', async () => {
      await seedUser();
      const first = await post('mfa/setup').expect(201);
      const second = await post('mfa/setup').expect(201);
      expect(second.body.secret).toBe(first.body.secret);
      expect(actions()).toEqual(['MFA_SETUP_STARTED', 'MFA_SETUP_STARTED']);
      expect(db.auditLogs.map((a) => a.metadata.pendingSecretReused)).toEqual([false, true]);
    });
  });

  describe('B. un TOTP solo vale una vez', () => {
    it('login/mfa: el mismo TOTP → 200 y luego 401', async () => {
      const { secret } = await seedUserWithMfa();
      const totp = await code(secret);
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: totp }).expect(200);
      const step = user().totpLastUsedStep;
      expect(step).toBe(Math.floor(BASE_NOW / 1000 / 30));
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: totp }).expect(401);
      expect(user().totpLastUsedStep).toBe(step);
      expect(actions()).toEqual(['MFA_LOGIN_VERIFIED', 'MFA_LOGIN_FAILED']);
      expect(db.refreshTokens).toHaveLength(1);
    });

    it('login/mfa: dos peticiones concurrentes con el mismo TOTP → solo una gana', async () => {
      const { secret } = await seedUserWithMfa();
      const totp = await code(secret);
      const [t1, t2] = await Promise.all([pendingToken(), pendingToken()]);
      const results = await Promise.all([
        post('login/mfa').send({ pendingToken: t1, code: totp }),
        post('login/mfa').send({ pendingToken: t2, code: totp }),
      ]);
      // El perdedor recibe 401 (código ya usado) o 429 (otro intento en curso).
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401 || r.status === 429)).toHaveLength(1);
      expect(db.refreshTokens).toHaveLength(1);
    });

    it('el código del paso siguiente sí se acepta', async () => {
      const { secret } = await seedUserWithMfa();
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: await code(secret) }).expect(200);
      now = BASE_NOW + 30_000;
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: await code(secret) }).expect(200);
    });

    it('confirm: el TOTP usado para activar no vale después para iniciar sesión', async () => {
      await seedUser();
      const setup = await post('mfa/setup').expect(201);
      const totp = await code(setup.body.secret);
      await post('mfa/confirm').send({ password: PASSWORD, code: totp }).expect(201);
      expect(user().totpEnabled).toBe(true);
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: totp }).expect(401);
    });

    it('disable: un TOTP ya usado en login/mfa → 401 y el MFA sigue activo', async () => {
      const { secret } = await seedUserWithMfa();
      const totp = await code(secret);
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: totp }).expect(200);
      const before = structuredClone(user());
      await post('mfa/disable').send({ password: PASSWORD, code: totp }).expect(401);
      expect(user()).toEqual({ ...before, mfaFailedAttempts: 1 });
      expect(actions()).toContain('MFA_DISABLE_FAILED');
    });

    it('un código de recuperación es de un solo uso', async () => {
      const { recovery } = await seedUserWithMfa();
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: recovery[0] }).expect(200);
      expect(user().mfaRecoveryCodes).toHaveLength(1);
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: recovery[0] }).expect(401);
      await post('mfa/disable').send({ password: PASSWORD, code: recovery[0] }).expect(401);
      expect(user().totpEnabled).toBe(true);
      expect(actions()).toEqual(['MFA_RECOVERY_CODE_USED', 'MFA_LOGIN_FAILED', 'MFA_DISABLE_FAILED']);
      expect(db.auditLogs[0].metadata).toEqual({ context: 'login', remainingRecoveryCodes: 1 });
    });

    it('sin serialización, el consumo optimista del recovery code sigue impidiendo el doble uso', async () => {
      const { recovery } = await seedUserWithMfa();
      // Defensa en profundidad: aunque el lock por usuario no existiera, ambas peticiones
      // leen el usuario antes de que ninguna escriba y aun así solo una gana.
      db.advisoryLocks = false;
      const mfa = app.get(MfaService);
      const actor = { userId: USER_ID, workspaceId: WORKSPACE_ID };
      const results = await Promise.allSettled([
        mfa.verifyLoginSecondFactor(actor, recovery[0], {}, 0),
        mfa.verifyLoginSecondFactor(actor, recovery[0], {}, 0),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(user().mfaRecoveryCodes).toHaveLength(1);
    });

    it('sin serialización, el reclamo atómico del paso TOTP sigue impidiendo el doble uso', async () => {
      const { secret } = await seedUserWithMfa();
      db.advisoryLocks = false;
      const mfa = app.get(MfaService);
      const actor = { userId: USER_ID, workspaceId: WORKSPACE_ID };
      const totp = await code(secret);
      const results = await Promise.allSettled([
        mfa.verifyLoginSecondFactor(actor, totp, {}, 0),
        mfa.verifyLoginSecondFactor(actor, totp, {}, 0),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    });
  });

  describe('flujo del smoke (cuenta SIN MFA previo): setup → confirm → disable', () => {
    it('funciona desactivando con un código de recuperación', async () => {
      await seedUser();
      const setup = await post('mfa/setup').expect(201);
      const confirm = await post('mfa/confirm').send({ password: PASSWORD, code: await code(setup.body.secret) }).expect(201);
      expect(confirm.body.recoveryCodes).toHaveLength(10);
      await post('mfa/disable').send({ password: PASSWORD, code: confirm.body.recoveryCodes[0] }).expect(201);
      expect(user()).toMatchObject({ totpEnabled: false, totpSecret: null, mfaRecoveryCodes: [], totpLastUsedStep: null });
      expect(actions()).toEqual(['MFA_SETUP_STARTED', 'MFA_ENABLED', 'MFA_RECOVERY_CODE_USED', 'MFA_DISABLED']);
    });

    it('desactivar con el MISMO TOTP del confirm se rechaza; con el del paso siguiente funciona', async () => {
      await seedUser();
      const setup = await post('mfa/setup').expect(201);
      const totp = await code(setup.body.secret);
      await post('mfa/confirm').send({ password: PASSWORD, code: totp }).expect(201);
      await post('mfa/disable').send({ password: PASSWORD, code: totp }).expect(401);
      now = BASE_NOW + 30_000;
      await post('mfa/disable').send({ password: PASSWORD, code: await code(setup.body.secret) }).expect(201);
      expect(user().totpEnabled).toBe(false);
    });

    it('tras desactivar se puede volver a activar enseguida (el paso usado se reinicia)', async () => {
      await seedUser();
      let setup = await post('mfa/setup').expect(201);
      const confirm = await post('mfa/confirm').send({ password: PASSWORD, code: await code(setup.body.secret) }).expect(201);
      await post('mfa/disable').send({ password: PASSWORD, code: confirm.body.recoveryCodes[0] }).expect(201);
      setup = await post('mfa/setup').expect(201);
      await post('mfa/confirm').send({ password: PASSWORD, code: await code(setup.body.secret) }).expect(201);
      expect(user().totpEnabled).toBe(true);
    });
  });

  describe('D. auditoría transaccional', () => {
    it('confirm: si falla la auditoría no se activa el MFA', async () => {
      await seedUser();
      const setup = await post('mfa/setup').expect(201);
      const before = structuredClone(user());
      db.failAuditAction = 'MFA_ENABLED';
      await post('mfa/confirm').send({ password: PASSWORD, code: await code(setup.body.secret) }).expect(500);
      expect(user()).toEqual(before);
      expect(user().totpEnabled).toBe(false);
    });

    it('setup: si falla la auditoría no se guarda el secreto', async () => {
      await seedUser();
      db.failAuditAction = 'MFA_SETUP_STARTED';
      await post('mfa/setup').expect(500);
      expect(user().totpSecret).toBeNull();
    });

    it('login con código de recuperación: si falla la auditoría el código no se consume ni hay sesión', async () => {
      const { recovery } = await seedUserWithMfa();
      const token = await pendingToken();
      db.failAuditAction = 'MFA_RECOVERY_CODE_USED';
      await post('login/mfa').send({ pendingToken: token, code: recovery[0] }).expect(500);
      expect(user().mfaRecoveryCodes).toHaveLength(2);
      expect(db.refreshTokens).toHaveLength(0);
    });

    it('login con TOTP: si falla la auditoría el paso no queda consumido ni hay sesión', async () => {
      const { secret } = await seedUserWithMfa();
      const token = await pendingToken();
      db.failAuditAction = 'MFA_LOGIN_VERIFIED';
      await post('login/mfa').send({ pendingToken: token, code: await code(secret) }).expect(500);
      expect(user().totpLastUsedStep).toBeNull();
      expect(db.refreshTokens).toHaveLength(0);
    });

    it('disable: si falla la auditoría el MFA sigue activo', async () => {
      const { secret } = await seedUserWithMfa();
      const before = structuredClone(user());
      db.failAuditAction = 'MFA_DISABLED';
      await post('mfa/disable').send({ password: PASSWORD, code: await code(secret) }).expect(500);
      expect(user()).toEqual(before);
    });

    it('registra fallos relevantes (contraseña y código incorrectos)', async () => {
      await seedUserWithMfa();
      await post('mfa/disable').send({ password: 'otra-contrasena-ficticia', code: '000000' }).expect(401);
      await post('mfa/disable').send({ password: PASSWORD, code: '99999-99999' }).expect(401);
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: '99999-99999' }).expect(401);
      expect(db.auditLogs.map((a) => [a.action, a.metadata.reason])).toEqual([
        ['MFA_DISABLE_FAILED', 'invalid_password'],
        ['MFA_DISABLE_FAILED', 'invalid_code'],
        ['MFA_LOGIN_FAILED', 'invalid_code'],
      ]);
      for (const entry of db.auditLogs) {
        expect(entry).toMatchObject({ workspaceId: WORKSPACE_ID, actorId: USER_ID, entityType: 'User', entityId: USER_ID });
      }
    });

    it('la auditoría nunca contiene secretos, códigos, contraseñas ni tokens', async () => {
      await seedUser();
      const setup = await post('mfa/setup').expect(201);
      const totp = await code(setup.body.secret);
      const confirm = await post('mfa/confirm').send({ password: PASSWORD, code: totp }).expect(201);
      const token = await pendingToken();
      await post('login/mfa').send({ pendingToken: token, code: confirm.body.recoveryCodes[0] }).expect(200);
      await post('mfa/disable').send({ password: PASSWORD, code: confirm.body.recoveryCodes[1] }).expect(201);
      const dump = JSON.stringify(db.auditLogs);
      for (const sensitive of [setup.body.secret, totp, PASSWORD, token, ...confirm.body.recoveryCodes]) {
        expect(dump).not.toContain(sensitive);
      }
      expect(actions()).toEqual([
        'MFA_SETUP_STARTED', 'MFA_ENABLED', 'MFA_RECOVERY_CODE_USED', 'MFA_RECOVERY_CODE_USED', 'MFA_DISABLED',
      ]);
    });
  });

  describe('1. confirm exige la contraseña actual', () => {
    it('sin contraseña → 400 (validación) y el MFA no se activa', async () => {
      await seedUser();
      const setup = await post('mfa/setup').expect(201);
      await post('mfa/confirm').send({ code: await code(setup.body.secret) }).expect(400);
      expect(user().totpEnabled).toBe(false);
    });

    it('contraseña incorrecta → 401, MFA no activo y auditado como bad_password', async () => {
      await seedUser();
      const setup = await post('mfa/setup').expect(201);
      await post('mfa/confirm').send({ password: 'otra-contrasena-ficticia', code: await code(setup.body.secret) }).expect(401);
      expect(user()).toMatchObject({ totpEnabled: false, mfaRecoveryCodes: [], totpLastUsedStep: null, mfaFailedAttempts: 1 });
      const failure = db.auditLogs.find((a) => a.action === 'MFA_CONFIRM_FAILED');
      expect(failure.metadata).toMatchObject({ reason: 'bad_password' });
      expect(JSON.stringify(db.auditLogs)).not.toContain('otra-contrasena-ficticia');
    });
  });

  describe('2. límite de intentos de segundo factor por cuenta', () => {
    const auth = () => app.get(AuthService);
    const wrong = '000000';

    async function loginToken() {
      const res = await auth().login({ email: EMAIL, password: PASSWORD } as any, {});
      if (!res.mfaRequired) throw new Error('se esperaba MFA');
      return res.pendingToken;
    }

    it('ráfaga de 20 intentos simultáneos con el mismo token → como mucho 5 evaluados, los demás 429', async () => {
      const { secret } = await seedUserWithMfa();
      const token = await loginToken();
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => auth().verifyMfaLogin(token, wrong, { ip: `203.0.113.${i + 1}` })),
      );
      const statuses = results.map((r) => (r as PromiseRejectedResult).reason?.status);
      expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
      expect(user().mfaFailedAttempts).toBeLessThanOrEqual(MFA_PENDING_TOKEN_MAX_FAILURES);
      // El token nunca permite más de MFA_PENDING_TOKEN_MAX_FAILURES evaluaciones.
      for (let i = 0; i < 10; i++) await auth().verifyMfaLogin(token, wrong, {}).catch(() => undefined);
      expect(user().mfaFailedAttempts).toBe(MFA_PENDING_TOKEN_MAX_FAILURES);
      expect(user().mfaLockedUntil).not.toBeNull();
      await expect(auth().verifyMfaLogin(await loginToken(), await code(secret), {})).rejects.toMatchObject({ status: 429 });
    });

    it('la espera crece con los fallos y tiene tope (nunca permanente)', () => {
      expect([0, 4, 5, 9, 10, 14, 15, 50, 10_000].map(mfaLockDurationMs)).toEqual([
        0, 0, 60_000, 60_000, 300_000, 300_000, 900_000, 900_000, 900_000,
      ]);
    });

    it('5 fallos con el mismo pendingToken desde IPs distintas → token anulado y cuenta en espera; tras la espera el legítimo entra', async () => {
      const { secret } = await seedUserWithMfa();
      const token = await loginToken();
      for (let i = 0; i < 5; i++) {
        await expect(auth().verifyMfaLogin(token, wrong, { ip: `203.0.113.${i + 1}` })).rejects.toMatchObject({ status: 401 });
      }
      expect(user().mfaFailedAttempts).toBe(5);
      expect(user().mfaLockedUntil!.getTime()).toBe(BASE_NOW + 60_000);

      // El mismo pendingToken ya no vale ni con el código correcto, venga de donde venga.
      await expect(auth().verifyMfaLogin(token, await code(secret), { ip: '198.51.100.7' })).rejects.toMatchObject({
        status: 401, message: expect.stringMatching(/vuelve a iniciar sesión/),
      });
      // Con un token nuevo, mientras dure la espera: 429 sin comprobar el código.
      const fresh = await loginToken();
      await expect(auth().verifyMfaLogin(fresh, await code(secret), {})).rejects.toMatchObject({ status: 429 });
      expect(user().totpLastUsedStep).toBeNull();

      now = BASE_NOW + 61_000;
      const session = await auth().verifyMfaLogin(fresh, await code(secret), {});
      expect(session.accessToken).toBeTruthy();
      expect(user()).toMatchObject({ mfaFailedAttempts: 0, mfaLockedUntil: null });
      const lockAudit = db.auditLogs.find((a) => a.metadata?.lockedForSeconds);
      expect(lockAudit.metadata).toEqual({ reason: 'invalid_code', failedAttempts: 5, lockedForSeconds: 60 });
      expect(db.auditLogs.map((a) => a.metadata?.reason)).toEqual(
        expect.arrayContaining(['pending_token_exhausted', 'locked']),
      );
    });

    it('a partir del 5.º fallo cada fallo cuesta 1 min de espera; tras el 10.º, 5 min', async () => {
      await seedUserWithMfa();
      let token = await loginToken();
      for (let i = 0; i < 5; i++) {
        await expect(auth().verifyMfaLogin(token, wrong, {})).rejects.toMatchObject({ status: 401 });
      }
      for (let failures = 6; failures <= 10; failures++) {
        now += 61_000; // se agota la espera anterior
        token = await loginToken(); // el token anterior quedó anulado
        await expect(auth().verifyMfaLogin(token, wrong, {})).rejects.toMatchObject({ status: 401 });
        // Sin esperar, el siguiente intento ya no se evalúa.
        await expect(auth().verifyMfaLogin(token, wrong, {})).rejects.toMatchObject({ status: 429 });
        expect(user().mfaFailedAttempts).toBe(failures);
      }
      expect(user().mfaLockedUntil!.getTime()).toBe(now + 5 * 60_000);
    });

    it('durante la espera no se cuentan intentos (no se alarga) y un recovery code válido tampoco se consume', async () => {
      const { recovery } = await seedUserWithMfa();
      const lockedUntil = new Date(BASE_NOW + 60_000);
      db.users.get(USER_ID)!.mfaFailedAttempts = 5;
      db.users.get(USER_ID)!.mfaLockedUntil = lockedUntil;
      const token = await loginToken();
      await expect(auth().verifyMfaLogin(token, recovery[0], {})).rejects.toMatchObject({ status: 429 });
      await expect(auth().verifyMfaLogin(token, wrong, {})).rejects.toMatchObject({ status: 429 });
      expect(user()).toMatchObject({ mfaFailedAttempts: 5, mfaLockedUntil: lockedUntil });
      expect(user().mfaRecoveryCodes).toHaveLength(2);
    });

    it('los fallos con código de recuperación cuentan igual', async () => {
      await seedUserWithMfa();
      const token = await loginToken();
      for (let i = 0; i < 5; i++) {
        await expect(auth().verifyMfaLogin(token, '99999-99999', {})).rejects.toMatchObject({ status: 401 });
      }
      expect(user().mfaFailedAttempts).toBe(5);
      expect(user().mfaLockedUntil).not.toBeNull();
    });

    it('disable también respeta la espera (429)', async () => {
      const { secret } = await seedUserWithMfa({ mfaFailedAttempts: 5, mfaLockedUntil: new Date(BASE_NOW + 60_000) });
      await post('mfa/disable').send({ password: PASSWORD, code: await code(secret) }).expect(429);
      expect(user().totpEnabled).toBe(true);
    });

    it('un pendingToken sin contador (emitido antes de este cambio) no vale', async () => {
      const { secret } = await seedUserWithMfa();
      const legacy = await app.get(JwtService).signAsync({ sub: USER_ID, kind: 'mfa_pending' }, { expiresIn: '5m' });
      await expect(auth().verifyMfaLogin(legacy, await code(secret), {})).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('4. tolerancia de reloj ±1 paso con anti-replay', () => {
    it('acepta el código del paso anterior y guarda ESE paso', async () => {
      const { secret } = await seedUserWithMfa();
      const previous = await generate({ secret, epoch: Math.floor(BASE_NOW / 1000) - 30 });
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: previous }).expect(200);
      expect(user().totpLastUsedStep).toBe(Math.floor(BASE_NOW / 1000 / 30) - 1);
    });

    it('tras usar el paso actual, el código del paso anterior ya no vale', async () => {
      const { secret } = await seedUserWithMfa();
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: await code(secret) }).expect(200);
      const previous = await generate({ secret, epoch: Math.floor(BASE_NOW / 1000) - 30 });
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: previous }).expect(401);
    });

    it('no acepta códigos a dos pasos de distancia', async () => {
      const { secret } = await seedUserWithMfa();
      const old = await generate({ secret, epoch: Math.floor(BASE_NOW / 1000) - 60 });
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: old }).expect(401);
    });

    it('totpLastUsedStep por delante del paso actual → TOTP 401, pero el código de recuperación entra', async () => {
      const { secret, recovery } = await seedUserWithMfa();
      db.users.get(USER_ID)!.totpLastUsedStep = Math.floor(BASE_NOW / 1000 / 30) + 5;
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: await code(secret) }).expect(401);
      await post('login/mfa').send({ pendingToken: await pendingToken(), code: recovery[0] }).expect(200);
    });
  });

  describe('C. Cache-Control: no-store', () => {
    it.each([
      ['login', { email: EMAIL, password: PASSWORD }],
      ['login/mfa', { pendingToken: 'x', code: '000000' }],
      ['refresh', undefined],
      ['mfa/setup', undefined],
      ['mfa/confirm', { password: PASSWORD, code: '000000' }],
      ['mfa/disable', { password: PASSWORD, code: '000000' }],
    ])('%s responde con no-store (también en error)', async (path, body) => {
      await seedUser();
      const res = await post(path).send(body as any);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('E. throttle en mfa/*', () => {
    it.each(['setupMfa', 'confirmMfaSetup', 'disableMfa', 'login', 'loginMfa'])('%s tiene límite 5/min', (handler) => {
      const fn = (AuthController.prototype as any)[handler];
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', fn)).toBe(5);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', fn)).toBe(60_000);
    });
  });
});

describe('JwtAuthGuard (regresión, sin cambios)', () => {
  const guard = new JwtAuthGuard();
  const ctx = (url: string) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ originalUrl: url, url }) }) }) as unknown as ExecutionContext;
  const principal = (role: string, mfaEnabled: boolean) => ({ sub: 'u', workspaceId: 'w', role, email: 'x@example.test', mfaEnabled });

  it('ASSISTANT sin MFA no queda bloqueado', () => {
    expect(guard.handleRequest(null, principal('ASSISTANT', false), null, ctx('/api/v1/patients'))).toBeTruthy();
  });

  it.each(['/api/v1/auth/mfa/setup', '/api/v1/auth/mfa/confirm', '/api/v1/auth/logout'])(
    'THERAPIST sin MFA alcanza %s',
    (url) => {
      expect(guard.handleRequest(null, principal('THERAPIST', false), null, ctx(url))).toBeTruthy();
    },
  );

  it.each(['/api/v1/patients', '/api/v1/auth/mfa/disable', '/api/v1/sessions?x=/auth/logout'])(
    'THERAPIST sin MFA no alcanza %s',
    (url) => {
      expect(() => guard.handleRequest(null, principal('THERAPIST', false), null, ctx(url))).toThrow(/verificación en dos pasos/);
    },
  );

  it('THERAPIST con MFA alcanza cualquier ruta', () => {
    expect(guard.handleRequest(null, principal('THERAPIST', true), null, ctx('/api/v1/patients'))).toBeTruthy();
  });
});
