import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import request = require('supertest');
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { MfaService } from '../src/auth/mfa.service';
import { PrismaService } from '../src/database/prisma.service';
import { RegistrationService } from '../src/auth/registration.service';
import { hashInviteToken } from '../src/auth/invite-token.util';
import { getCurrentLegalDocuments } from '../src/legal/legal-documents';
import { fakeRegistrationDb } from './support/fake-registration-db';

/**
 * POST /auth/register: el atributo "¿Atiendes pacientes?" (isClinician) es estrictamente booleano.
 * Condición de Argos sobre feat/e1-web: con el ValidationPipe global (transform: true) un valor
 * como "yes", "true", 1 u "on" NO puede convertirse en true y crear un OWNER clínico. Debe ser 400
 * y no escribir nada. Sin isClinician, o con false, el OWNER nace no clínico; con true, clínico.
 *
 * Datos 100 % ficticios.
 */

const DAY = 24 * 60 * 60 * 1000;
const TOKEN = 'token-ficticio-de-invitacion-isclinician-0123456789';
const BASE_BODY = {
  firstName: 'Titular',
  lastName: 'Ficticio',
  password: 'contrasena-ficticia-123',
  workspaceName: 'Consulta Ficticia QA',
};

// Desde feat/registro-por-invitacion el alta exige invitación y condiciones vigentes: cada test
// parte de una BD en memoria con una invitación válida para su correo (ver fake-registration-db).
const currentTerms = () => getCurrentLegalDocuments().map((d) => ({ documentType: d.type, version: d.version, textHash: d.textHash }));
const inviteFor = (email: string) => ({
  id: 'inv-isclinician', tokenHash: hashInviteToken(TOKEN), email, expiresAt: new Date(Date.now() + 14 * DAY),
  createdBy: 'cli', createdAt: new Date(), usedAt: null, revokedAt: null, usedByUserId: null, workspaceId: null,
});

describe('POST /auth/register valida isClinician como booleano estricto', () => {
  let app: INestApplication;
  let db: any = fakeRegistrationDb();
  // El proveedor apunta siempre a la BD del test en curso.
  const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
  let seq = 0;
  const store = () => db.__store;
  /** Correo nuevo con su invitación válida sembrada en una BD limpia. */
  const email = () => {
    const value = `titular.registro.${++seq}@example.test`;
    db = fakeRegistrationDb({ registrationInvite: [inviteFor(value)] });
    return value;
  };
  const body = (extra: Record<string, unknown>) => ({ ...BASE_BODY, inviteToken: TOKEN, acceptedTerms: currentTerms(), ...extra });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'secreto-solo-para-tests-registro', signOptions: { expiresIn: '15m' } })],
      controllers: [AuthController],
      providers: [
        AuthService,
        RegistrationService,
        { provide: MfaService, useValue: {} },
        { provide: PrismaService, useValue: prismaProxy },
      ],
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
      .send(body({ email: email(), isClinician: value }));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/isClinician/);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(store().user).toHaveLength(0);
    expect(store().workspace).toHaveLength(0);
    expect(store().workspaceMember).toHaveLength(0);
    expect(store().refreshToken).toHaveLength(0);
  });

  it.each([
    ['sin isClinician', undefined, false],
    ['isClinician = false', false, false],
    // @IsOptional deja pasar null; el servicio solo acepta === true, así que nace no clínico.
    ['isClinician = null', null, false],
    ['isClinician = true', true, true],
  ])('%s → 201 y OWNER con el isClinician esperado', async (_label, value, expected) => {
    const payload: Record<string, unknown> = body({ email: email() });
    if (value !== undefined) payload.isClinician = value;
    const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(payload);

    expect(res.status).toBe(201);
    expect(store().workspaceMember).toHaveLength(1);
    expect(store().workspaceMember[0]).toMatchObject({ role: 'OWNER', isClinician: expected });
  });

  it('un campo no declarado (role) junto al alta → 400: no se puede elegir el rol', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(body({ email: email(), role: 'THERAPIST' }));
    expect(res.status).toBe(400);
    expect(store().workspaceMember).toHaveLength(0);
  });
});
