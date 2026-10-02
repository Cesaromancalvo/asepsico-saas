import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import request = require('supertest');
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { MfaService } from '../src/auth/mfa.service';
import { PrismaService } from '../src/database/prisma.service';

/**
 * POST /auth/register: el atributo "¿Atiendes pacientes?" (isClinician) es estrictamente booleano.
 * Condición de Argos sobre feat/e1-web: con el ValidationPipe global (transform: true) un valor
 * como "yes", "true", 1 u "on" NO puede convertirse en true y crear un OWNER clínico. Debe ser 400
 * y no escribir nada. Sin isClinician, o con false, el OWNER nace no clínico; con true, clínico.
 *
 * Datos 100 % ficticios.
 */

const BASE_BODY = {
  firstName: 'Titular',
  lastName: 'Ficticio',
  password: 'contrasena-ficticia-123',
  workspaceName: 'Consulta Ficticia QA',
};

/** Prisma en memoria con lo justo para register + issueSession. */
class FakePrisma {
  users: any[] = [];
  workspaces: any[] = [];
  members: any[] = [];
  refreshTokens: any[] = [];

  user = {
    findUnique: async ({ where }: any) => this.users.find((u) => u.email === where.email || u.id === where.id) ?? null,
    create: async ({ data }: any) => {
      const row = { id: `user-${this.users.length + 1}`, totpEnabled: false, ...data };
      this.users.push(row);
      return row;
    },
  };
  workspace = {
    create: async ({ data }: any) => {
      const row = { id: `ws-${this.workspaces.length + 1}`, ...data };
      this.workspaces.push(row);
      return row;
    },
  };
  workspaceMember = {
    create: async ({ data }: any) => {
      const row = { id: `m-${this.members.length + 1}`, ...data };
      this.members.push(row);
      return row;
    },
  };
  refreshToken = {
    create: async ({ data }: any) => {
      this.refreshTokens.push(data);
      return data;
    },
  };
  auditLog = { create: async ({ data }: any) => data };

  async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return fn(this);
  }

  reset() {
    this.users = [];
    this.workspaces = [];
    this.members = [];
    this.refreshTokens = [];
  }
}

describe('POST /auth/register valida isClinician como booleano estricto', () => {
  let app: INestApplication;
  const db = new FakePrisma();
  let seq = 0;
  const email = () => `titular.registro.${++seq}@example.test`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'secreto-solo-para-tests-registro', signOptions: { expiresIn: '15m' } })],
      controllers: [AuthController],
      providers: [AuthService, { provide: MfaService, useValue: {} }, { provide: PrismaService, useFactory: () => db }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    // Mismas opciones que el pipe global de apps/api/src/main.ts.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => db.reset());

  it.each([
    ['"yes"', 'yes'],
    ['"true" (cadena)', 'true'],
    ['"on" (valor de checkbox)', 'on'],
    ['1', 1],
    ['"1"', '1'],
    ['objeto', { value: true }],
  ])('isClinician = %s → 400 sin crear usuario, workspace ni membresía', async (_label, value) => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...BASE_BODY, email: email(), isClinician: value });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/isClinician/);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(db.users).toHaveLength(0);
    expect(db.workspaces).toHaveLength(0);
    expect(db.members).toHaveLength(0);
    expect(db.refreshTokens).toHaveLength(0);
  });

  it.each([
    ['sin isClinician', undefined, false],
    ['isClinician = false', false, false],
    // @IsOptional deja pasar null; el servicio solo acepta === true, así que nace no clínico.
    ['isClinician = null', null, false],
    ['isClinician = true', true, true],
  ])('%s → 201 y OWNER con el isClinician esperado', async (_label, value, expected) => {
    const body: Record<string, unknown> = { ...BASE_BODY, email: email() };
    if (value !== undefined) body.isClinician = value;
    const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(body);

    expect(res.status).toBe(201);
    expect(db.members).toHaveLength(1);
    expect(db.members[0]).toMatchObject({ role: 'OWNER', isClinician: expected });
  });

  it('un campo no declarado (role) junto al alta → 400: no se puede elegir el rol', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...BASE_BODY, email: email(), role: 'THERAPIST' });
    expect(res.status).toBe(400);
    expect(db.members).toHaveLength(0);
  });
});
