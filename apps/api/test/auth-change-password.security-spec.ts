import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { compare, hash } from 'bcryptjs';
import * as cookieParser from 'cookie-parser';
import { generate } from 'otplib';
import request = require('supertest');
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { MfaService } from '../src/auth/mfa.service';
import { PasswordService } from '../src/auth/password.service';
import { RegistrationService } from '../src/auth/registration.service';
import { hashToken } from '../src/auth/token.util';
import { encryptField } from '../src/common/crypto/field-encryption';
import { CsrfGuard } from '../src/common/guards/csrf.guard';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { PrismaService } from '../src/database/prisma.service';

/**
 * POST /auth/change-password (profesionales). Todos los datos son ficticios.
 *  - Contraseña actual errónea → 401 genérico, cuenta como fallo de la cuenta y no cambia nada.
 *  - MFA activo → exige un TOTP válido y no reutilizado; con MFA el error no distingue qué falló.
 *  - Éxito → hash nuevo, TODOS los refresh tokens del usuario revocados (todos sus workspaces),
 *    sesión nueva emitida en este navegador y AuditLog USER_PASSWORD_CHANGED sin datos personales.
 *  - Workspace: la auditoría y el rol salen del workspace del token; sin membresía en él → 401.
 *  - Política: mínimo 12 caracteres, máximo 72 bytes, distinta de la actual. CSRF y JWT obligatorios.
 *  - Límite de 5 peticiones por minuto (ThrottlerGuard).
 */

const PASSWORD = 'contrasena-ficticia-123';
const NEW_PASSWORD = 'otra-contrasena-ficticia-456';
const WORKSPACE_ID = 'ws-ficticio-1';
const OTHER_WORKSPACE_ID = 'ws-ficticio-2';
const USER_ID = 'user-ficticio-1';
const OTHER_USER_ID = 'user-ficticio-2';
const EMAIL = 'terapeuta.cambio@example.test';
const CSRF = 'csrf-ficticio';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const BASE_NOW = Date.UTC(2026, 0, 15, 10, 0, 15);

type FakeUser = {
  id: string; email: string; passwordHash: string; firstName: string; lastName: string;
  totpSecret: string | null; totpEnabled: boolean; totpLastUsedStep: number | null; mfaRecoveryCodes: string[];
  mfaFailedAttempts: number; mfaLockedUntil: Date | null;
};
type FakeToken = { id: string; userId: string; workspaceId: string; tokenHash: string; family: string; revokedAt: Date | null; expiresAt: Date };

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return (cond as any[]).some((w) => matches(row, w));
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('lt' in cond) return row[key] !== null && row[key] < cond.lt;
      throw new Error(`Condición no soportada en el fake: ${key}`);
    }
    return row[key] === cond;
  });
}

/** Prisma en memoria con transacciones que revierten usuarios, tokens y auditoría si el callback lanza. */
class FakePrisma {
  users = new Map<string, FakeUser>();
  members: Array<{ userId: string; workspaceId: string; role: string }> = [];
  refreshTokens: FakeToken[] = [];
  auditLogs: any[] = [];
  failAuditAction: string | null = null;
  /** Consultas de membresía recibidas (para comprobar que filtran por workspace). */
  memberQueries: any[] = [];

  user = {
    findUnique: async ({ where }: any) => {
      const u = this.users.get(where.id);
      return u ? structuredClone(u) : null;
    },
    update: async ({ where, data, select }: any) => {
      const u = this.users.get(where.id)!;
      for (const [key, value] of Object.entries(data) as [string, any][]) {
        (u as any)[key] = value && typeof value === 'object' && 'increment' in value ? (u as any)[key] + value.increment : structuredClone(value);
      }
      const copy: any = structuredClone(u);
      return select ? Object.fromEntries(Object.keys(select).map((k) => [k, copy[k]])) : copy;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const u of this.users.values()) if (matches(u, where)) { Object.assign(u, structuredClone(data)); count++; }
      return { count };
    },
  };

  workspaceMember = {
    findFirst: async ({ where }: any) => {
      this.memberQueries.push(structuredClone(where));
      const m = this.members.find((x) => matches(x, where));
      return m ? { role: m.role } : null;
    },
  };

  refreshToken = {
    findUnique: async ({ where }: any) => structuredClone(this.refreshTokens.find((t) => t.tokenHash === where.tokenHash) ?? null),
    create: async ({ data }: any) => {
      const row = { id: `rt-${this.refreshTokens.length + 1}`, revokedAt: null, ...data };
      this.refreshTokens.push(row);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const t of this.refreshTokens) if (matches(t, where)) { Object.assign(t, data); count++; }
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

  heldLocks = new Set<string>();

  async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const snapshot = {
      users: structuredClone([...this.users.entries()]),
      tokens: structuredClone(this.refreshTokens),
      audit: structuredClone(this.auditLogs),
    };
    const held: string[] = [];
    const tx = Object.create(this);
    tx.$queryRaw = async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      const key = values.join('|');
      if (this.heldLocks.has(key)) return [{ acquired: false }];
      this.heldLocks.add(key);
      held.push(key);
      return [{ acquired: true }];
    };
    try {
      return await fn(tx);
    } catch (error) {
      this.users = new Map(snapshot.users);
      this.refreshTokens = snapshot.tokens;
      this.auditLogs = snapshot.audit;
      throw error;
    } finally {
      for (const key of held) this.heldLocks.delete(key);
    }
  }
}

let currentActor: any = { sub: USER_ID, workspaceId: WORKSPACE_ID, role: 'THERAPIST', email: EMAIL };
class TestJwtGuard {
  canActivate(context: ExecutionContext) {
    context.switchToHttp().getRequest().user = currentActor;
    return true;
  }
}

async function buildApp(db: FakePrisma, withThrottler = false): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      JwtModule.register({ secret: 'secreto-solo-para-tests', signOptions: { expiresIn: '15m' } }),
      ...(withThrottler ? [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])] : []),
    ],
    controllers: [AuthController],
    providers: [
      AuthService, MfaService, RegistrationService, PasswordService, CsrfGuard,
      { provide: PrismaService, useFactory: () => db },
      ...(withThrottler ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }] : []),
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useClass(TestJwtGuard)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  return app;
}

describe('POST /auth/change-password', () => {
  let app: INestApplication;
  let db: FakePrisma;
  let passwordHash: string;
  let now = BASE_NOW;

  const post = (body: Record<string, unknown>, target = app) =>
    request(target.getHttpServer()).post('/api/v1/auth/change-password').set('Cookie', `csrf_token=${CSRF}`).set('x-csrf-token', CSRF).send(body);
  const user = () => db.users.get(USER_ID)!;
  const actions = () => db.auditLogs.map((a) => a.action);
  const totp = () => generate({ secret: SECRET });

  function seedUser(overrides: Partial<FakeUser> = {}) {
    db.users.set(USER_ID, {
      id: USER_ID, email: EMAIL, passwordHash, firstName: 'Ana', lastName: 'Ficticia',
      totpSecret: null, totpEnabled: false, totpLastUsedStep: null, mfaRecoveryCodes: [],
      mfaFailedAttempts: 0, mfaLockedUntil: null, ...overrides,
    });
  }
  const seedUserWithMfa = () => seedUser({ totpSecret: encryptField(SECRET), totpEnabled: true });

  function seedSessions() {
    const exp = new Date(BASE_NOW + 86_400_000);
    db.refreshTokens.push(
      { id: 'rt-a', userId: USER_ID, workspaceId: WORKSPACE_ID, tokenHash: hashToken('actual'), family: 'f-a', revokedAt: null, expiresAt: exp },
      { id: 'rt-b', userId: USER_ID, workspaceId: WORKSPACE_ID, tokenHash: hashToken('portatil'), family: 'f-b', revokedAt: null, expiresAt: exp },
      { id: 'rt-c', userId: USER_ID, workspaceId: OTHER_WORKSPACE_ID, tokenHash: hashToken('otra-consulta'), family: 'f-c', revokedAt: null, expiresAt: exp },
      { id: 'rt-x', userId: OTHER_USER_ID, workspaceId: WORKSPACE_ID, tokenHash: hashToken('companera'), family: 'f-x', revokedAt: null, expiresAt: exp },
    );
  }

  beforeAll(async () => {
    passwordHash = await hash(PASSWORD, 4);
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    db = new FakePrisma();
    app = await buildApp(db);
  });

  beforeEach(() => {
    now = BASE_NOW;
    db.users.clear();
    db.refreshTokens = [];
    db.auditLogs = [];
    db.memberQueries = [];
    db.failAuditAction = null;
    db.heldLocks.clear();
    db.members = [
      { userId: USER_ID, workspaceId: WORKSPACE_ID, role: 'THERAPIST' },
      { userId: USER_ID, workspaceId: OTHER_WORKSPACE_ID, role: 'OWNER' },
    ];
    currentActor = { sub: USER_ID, workspaceId: WORKSPACE_ID, role: 'THERAPIST', email: EMAIL };
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  describe('contraseña actual errónea', () => {
    it('→ 401 genérico con código estable, no cambia el hash ni revoca sesiones y cuenta el fallo', async () => {
      seedUser();
      seedSessions();
      const res = await post({ currentPassword: 'no-es-la-buena-123', newPassword: NEW_PASSWORD }).expect(401);
      expect(res.body).toMatchObject({ code: 'CHANGE_PASSWORD_INVALID', message: 'La contraseña actual no es correcta.' });
      expect(user().passwordHash).toBe(passwordHash);
      expect(db.refreshTokens.every((t) => t.revokedAt === null)).toBe(true);
      expect(user().mfaFailedAttempts).toBe(1);
      expect(actions()).toEqual(['USER_PASSWORD_CHANGE_FAILED']);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('con MFA, contraseña mala y código bueno da el MISMO error que contraseña buena y código malo', async () => {
      seedUserWithMfa();
      const badPassword = await post({ currentPassword: 'no-es-la-buena-123', newPassword: NEW_PASSWORD, mfaCode: await totp() }).expect(401);
      const badCode = await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, mfaCode: '000000' }).expect(401);
      expect(badPassword.body).toEqual(badCode.body);
      expect(badCode.body.message).toBe('La contraseña actual o el código no son correctos.');
      expect(user().passwordHash).toBe(passwordHash);
    });

    it('5 fallos activan la espera de la cuenta: después ni la contraseña buena pasa (429)', async () => {
      seedUser();
      for (let i = 0; i < 5; i++) await post({ currentPassword: `mala-${i}-ficticia`, newPassword: NEW_PASSWORD }).expect(401);
      expect(user().mfaLockedUntil).not.toBeNull();
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(429);
      expect(user().passwordHash).toBe(passwordHash);
    });
  });

  describe('MFA requerido', () => {
    it('sin mfaCode → 400 MFA_CODE_REQUIRED, sin comprobar la contraseña ni contar fallo', async () => {
      seedUserWithMfa();
      const res = await post({ currentPassword: 'cualquiera-ficticia', newPassword: NEW_PASSWORD }).expect(400);
      expect(res.body.code).toBe('MFA_CODE_REQUIRED');
      expect(user().mfaFailedAttempts).toBe(0);
      expect(user().passwordHash).toBe(passwordHash);
    });

    it('código incorrecto → 401 y no cambia nada', async () => {
      seedUserWithMfa();
      seedSessions();
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, mfaCode: '123456' }).expect(401);
      expect(user().passwordHash).toBe(passwordHash);
      expect(db.refreshTokens.every((t) => t.revokedAt === null)).toBe(true);
      expect(user().mfaFailedAttempts).toBe(1);
    });

    it('código válido → 200 y el paso TOTP queda consumido (no se puede reutilizar)', async () => {
      seedUserWithMfa();
      const code = await totp();
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, mfaCode: code }).expect(200);
      expect(await compare(NEW_PASSWORD, user().passwordHash)).toBe(true);
      expect(user().totpLastUsedStep).not.toBeNull();
      // Mismo código otra vez (con la contraseña ya nueva): rechazado por anti-reutilización.
      await post({ currentPassword: NEW_PASSWORD, newPassword: 'tercera-contrasena-ficticia', mfaCode: code }).expect(401);
      expect(await compare(NEW_PASSWORD, user().passwordHash)).toBe(true);
    });

    it('no acepta códigos de recuperación (solo TOTP de 6 dígitos)', async () => {
      seedUserWithMfa();
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, mfaCode: '11111-22222' }).expect(400);
      expect(user().passwordHash).toBe(passwordHash);
    });
  });

  describe('éxito: revocación de sesiones y sesión nueva', () => {
    it('revoca TODOS los refresh tokens del usuario (también de su otro workspace), no los de otros usuarios', async () => {
      seedUser({ totpEnabled: false });
      seedSessions();
      const res = await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      expect(res.body).toEqual({ success: true, otherSessionsClosed: true });
      const old = db.refreshTokens.filter((t) => ['rt-a', 'rt-b', 'rt-c'].includes(t.id));
      expect(old.every((t) => t.revokedAt instanceof Date)).toBe(true);
      expect(db.refreshTokens.find((t) => t.id === 'rt-x')!.revokedAt).toBeNull();
      expect(await compare(NEW_PASSWORD, user().passwordHash)).toBe(true);
      expect(await compare(PASSWORD, user().passwordHash)).toBe(false);
    });

    it('emite una sesión nueva (familia nueva) para este navegador con cookies y no-store', async () => {
      seedUser();
      seedSessions();
      const res = await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      const fresh = db.refreshTokens.filter((t) => t.revokedAt === null && t.userId === USER_ID);
      expect(fresh).toHaveLength(1);
      expect(fresh[0].workspaceId).toBe(WORKSPACE_ID);
      expect(['f-a', 'f-b', 'f-c']).not.toContain(fresh[0].family);
      const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      expect(cookies.some((c) => c.startsWith('access_token='))).toBe(true);
      expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);
      expect(res.headers['cache-control']).toBe('no-store');
      // La respuesta no lleva tokens ni la contraseña.
      expect(JSON.stringify(res.body)).not.toMatch(/token|contrasena/i);
      // El access token nuevo usa el rol de la BD en el workspace del token.
      const access = cookies.find((c) => c.startsWith('access_token='))!.split(';')[0].slice('access_token='.length);
      const payload = new JwtService({ secret: 'secreto-solo-para-tests' }).verify(decodeURIComponent(access));
      expect(payload).toMatchObject({ sub: USER_ID, workspaceId: WORKSPACE_ID, role: 'THERAPIST', mfaEnabled: false });
    });

    it('un refresh token revocado ya no sirve para renovar', async () => {
      seedUser();
      seedSessions();
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', 'refresh_token=portatil').expect(401);
    });
  });

  describe('auditoría', () => {
    it('USER_PASSWORD_CHANGED en el workspace del token, sin datos personales', async () => {
      seedUserWithMfa();
      seedSessions();
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, mfaCode: await totp() }).set('User-Agent', 'navegador-ficticio').expect(200);
      const entries = db.auditLogs.filter((a) => a.action === 'USER_PASSWORD_CHANGED');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        workspaceId: WORKSPACE_ID,
        actorId: USER_ID,
        action: 'USER_PASSWORD_CHANGED',
        entityType: 'User',
        entityId: USER_ID,
        metadata: { revokedSessions: 3, mfaVerified: true },
      });
      const serialized = JSON.stringify(db.auditLogs);
      for (const secret of [PASSWORD, NEW_PASSWORD, EMAIL, 'Ana', 'Ficticia', 'navegador-ficticio', SECRET]) {
        expect(serialized).not.toContain(secret);
      }
    });

    it('si falla la auditoría se revierte todo: hash, revocaciones y sesión nueva', async () => {
      seedUser();
      seedSessions();
      db.failAuditAction = 'USER_PASSWORD_CHANGED';
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(500);
      expect(user().passwordHash).toBe(passwordHash);
      expect(db.refreshTokens).toHaveLength(4);
      expect(db.refreshTokens.every((t) => t.revokedAt === null)).toBe(true);
    });
  });

  describe('workspace correcto', () => {
    it('la membresía se busca por usuario Y workspace del token', async () => {
      seedUser();
      currentActor = { sub: USER_ID, workspaceId: OTHER_WORKSPACE_ID, role: 'OWNER', email: EMAIL };
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      expect(db.memberQueries).toEqual([{ userId: USER_ID, workspaceId: OTHER_WORKSPACE_ID }]);
      expect(db.auditLogs.find((a) => a.action === 'USER_PASSWORD_CHANGED').workspaceId).toBe(OTHER_WORKSPACE_ID);
      expect(db.refreshTokens.find((t) => t.revokedAt === null)!.workspaceId).toBe(OTHER_WORKSPACE_ID);
    });

    it('token de un workspace en el que ya no es miembro → 401 y no cambia nada', async () => {
      seedUser();
      seedSessions();
      currentActor = { sub: USER_ID, workspaceId: 'ws-ajeno', role: 'OWNER', email: EMAIL };
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(401);
      expect(user().passwordHash).toBe(passwordHash);
      expect(db.refreshTokens.every((t) => t.revokedAt === null)).toBe(true);
      expect(db.auditLogs.filter((a) => a.workspaceId === 'ws-ajeno')).toEqual([]);
    });

    it('solo cambia la contraseña del usuario del token', async () => {
      seedUser();
      db.users.set(OTHER_USER_ID, { ...user(), id: OTHER_USER_ID, email: 'companera@example.test' });
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      expect(db.users.get(OTHER_USER_ID)!.passwordHash).toBe(passwordHash);
    });
  });

  describe('política y protecciones', () => {
    it.each([
      ['menos de 12 caracteres', 'corta-11-ch'],
      ['más de 72 bytes', 'ñ'.repeat(37)],
    ])('nueva contraseña con %s → 400', async (_label, newPassword) => {
      seedUser();
      await post({ currentPassword: PASSWORD, newPassword }).expect(400);
      expect(user().passwordHash).toBe(passwordHash);
    });

    it('acepta exactamente 72 bytes', async () => {
      seedUser();
      await post({ currentPassword: PASSWORD, newPassword: 'a'.repeat(72) }).expect(200);
    });

    it('nueva igual a la actual → 400 PASSWORD_UNCHANGED', async () => {
      seedUser();
      const res = await post({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
      expect(res.body.code).toBe('PASSWORD_UNCHANGED');
    });

    it('campos extra → 400 (whitelist)', async () => {
      seedUser();
      await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, userId: OTHER_USER_ID }).expect(400);
    });

    it('sin CSRF → 403', async () => {
      seedUser();
      await request(app.getHttpServer()).post('/api/v1/auth/change-password').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(403);
      expect(user().passwordHash).toBe(passwordHash);
    });

    it('el endpoint exige JwtAuthGuard y CsrfGuard', () => {
      const guards: unknown[] = Reflect.getMetadata('__guards__', AuthController.prototype.changePassword) ?? [];
      expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, CsrfGuard]));
    });

    it('límite de 5 peticiones por minuto: la 6.ª recibe 429', async () => {
      const throttled = await buildApp(db, true);
      try {
        seedUser();
        const statuses: number[] = [];
        // Cuerpos inválidos (400): el límite cuenta las peticiones, no solo los fallos de contraseña.
        for (let i = 0; i < 6; i++) statuses.push((await post({ currentPassword: PASSWORD, newPassword: 'corta' }, throttled)).status);
        expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
      } finally {
        await throttled.close();
      }
    });
  });
});
