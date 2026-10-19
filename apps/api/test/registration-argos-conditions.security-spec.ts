import { ExecutionContext, INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as legalDocs from '../src/legal/legal-documents';
import { assertTermsAccepted, isTermsPendingAllowedPath, normalizeRequestPath, TERMS_ACCEPTANCE_REQUIRED } from '../src/legal/terms-acceptance';
import { LegalController } from '../src/legal/legal.controller';
import { LegalService } from '../src/legal/legal.service';
import { EnvironmentController } from '../src/health/environment.controller';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { PrismaService } from '../src/database/prisma.service';
import { fakeRegistrationDb } from './support/fake-registration-db';

/**
 * Condiciones de Argos para aprobar el registro por invitación (tests 1-3 y corrección C2).
 * El test 4 (428 → aceptar → sin 428 con Postgres real) está en scripts/smoke-live.mjs con
 * ASEPSICO_SMOKE_EXPECT_TERMS_428=1. Datos 100 % ficticios: ningún NIF ni domicilio es real.
 */

const META = { ip: '203.0.113.9', userAgent: 'jest' };
// Domicilio inventado (el código postal 00000 no existe).
const FAKE_ADDRESS = 'Calle Ficticia 1, 00000 Ciudad Inventada';

afterEach(() => jest.restoreAllMocks());

describe('Argos 1: un NIF no válido nunca aparece en el log ni en la respuesta', () => {
  // Valores mal formados o con la letra de control incorrecta (ninguno es un NIF válido).
  const INVALID_NIFS = ['12345678A', '1234567Z', 'X1234567A', '98765432-a'];
  let app: INestApplication;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LegalController],
      providers: [LegalService, { provide: PrismaService, useValue: fakeRegistrationDb() }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    process.env = savedEnv;
    await app.close();
  });

  it.each(INVALID_NIFS)('LEGAL_TITULAR_NIF=%j → aviso sin el valor, texto en borrador y la respuesta tampoco lo lleva', async (nif) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const staticWarn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
    const stdout = jest.spyOn(process.stdout, 'write');
    const stderr = jest.spyOn(process.stderr, 'write');

    process.env.LEGAL_TITULAR_NIF = nif;
    process.env.LEGAL_TITULAR_DOMICILIO = FAKE_ADDRESS;
    // Camino real: los documentos se construyen desde process.env, como en el despliegue.
    const docs = legalDocs.buildLegalDocuments();
    jest.spyOn(legalDocs, 'getCurrentLegalDocuments').mockReturnValue(docs);

    // El aviso existe (el espía funciona) y nombra la variable, no su valor.
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((args) => String(args[0]).includes('LEGAL_TITULAR_NIF'))).toBe(true);
    expect(docs.every((d) => d.draft)).toBe(true);

    const res = await request(app.getHttpServer()).get('/api/v1/legal/terms').expect(200);

    const variants = [nif, nif.toUpperCase(), nif.replace(/[\s.-]/g, '').toUpperCase(), nif.replace(/[A-Za-z]$/, '')];
    const logged = JSON.stringify([
      warn.mock.calls, staticWarn.mock.calls, ...consoleSpies.map((s) => s.mock.calls),
      stdout.mock.calls.map((c) => String(c[0])), stderr.mock.calls.map((c) => String(c[0])),
    ]);
    for (const value of variants) {
      expect(logged).not.toContain(value);
      expect(res.text).not.toContain(value);
    }
    // El marcador queda tal cual: el texto servido sigue siendo borrador.
    expect(res.body.every((d: any) => d.draft === true && d.text.includes('[NIF]'))).toBe(true);
    // El domicilio válido sí se rellena (el aviso es solo por el NIF).
    expect(warn.mock.calls.some((args) => String(args[0]).includes('LEGAL_TITULAR_DOMICILIO'))).toBe(false);
  });
});

describe('Argos 2: GET /api/v1/environment', () => {
  let app: INestApplication;
  const saved = process.env.DEMO_ENVIRONMENT;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [EnvironmentController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.DEMO_ENVIRONMENT; else process.env.DEMO_ENVIRONMENT = saved;
    await app.close();
  });

  it.each<[string | undefined, boolean]>([
    ['FALSE', true], ['0', true], ['', true], [undefined, true],
    ['False', true], [' false', true], ['false ', true], ['no', true], ['true', true],
    ['false', false],
  ])('DEMO_ENVIRONMENT=%j → exactamente { demo: %s }', async (value, expected) => {
    if (value === undefined) delete process.env.DEMO_ENVIRONMENT; else process.env.DEMO_ENVIRONMENT = value;
    const res = await request(app.getHttpServer()).get('/api/v1/environment').expect(200);
    expect(Object.keys(res.body)).toEqual(['demo']);
    expect(res.body).toStrictEqual({ demo: expected });
  });
});

describe('Argos 3: aceptar en el workspace A no sirve en el workspace B', () => {
  const USER = 'usuario-doble-1';
  const members = [
    { id: 'm-a', workspaceId: 'ws-a', userId: USER, role: 'OWNER', isClinician: true },
    { id: 'm-b', workspaceId: 'ws-b', userId: USER, role: 'ADMIN', isClinician: false },
  ];
  const inA = { sub: USER, workspaceId: 'ws-a', role: 'OWNER', email: 'doble@example.com' } as any;
  const inB = { ...inA, workspaceId: 'ws-b', role: 'ADMIN' };
  const currentTerms = () => legalDocs.getCurrentLegalDocuments().map((d) => ({ documentType: d.type, version: d.version, textHash: d.textHash }));

  it('mismo usuario, miembro de A y de B: acepta en A, sigue con 428 en B y la evidencia solo es de A', async () => {
    const prisma = fakeRegistrationDb({ workspaceMember: members });
    const service = new LegalService(prisma);

    await expect(service.accept(inA, { acceptedTerms: currentTerms() } as any, META)).resolves.toMatchObject({ acceptanceRequired: false });
    await expect(assertTermsAccepted(prisma, inA, '/api/v1/patients')).resolves.toBeUndefined();

    const error = await assertTermsAccepted(prisma, inB, '/api/v1/patients').catch((e) => e);
    expect(error?.getStatus?.()).toBe(428);
    expect(error.getResponse()).toMatchObject({ code: TERMS_ACCEPTANCE_REQUIRED });
    await expect(service.status(inB)).resolves.toMatchObject({ acceptanceRequired: true });

    expect(prisma.__store.termsAcceptance.length).toBeGreaterThan(0);
    expect(prisma.__store.termsAcceptance.every((r: any) => r.workspaceId === 'ws-a' && r.userId === USER)).toBe(true);
    expect(prisma.__store.auditLog.every((a: any) => a.workspaceId === 'ws-a')).toBe(true);
  });

  it('también a través de JwtAuthGuard: el token de B recibe 428 aunque A esté aceptado', async () => {
    // El guard revalida la sesión (membresía ACTIVE y tokenVersion): el usuario existe en la BD.
    const prisma = fakeRegistrationDb({ workspaceMember: members, user: [{ id: USER, email: 'doble@example.com' }] });
    await new LegalService(prisma).accept(inA, { acceptedTerms: currentTerms() } as any, META);
    jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate').mockResolvedValue(true);
    const ctx = (user: any) => ({ switchToHttp: () => ({ getRequest: () => ({ originalUrl: '/api/v1/patients', user }) }) }) as unknown as ExecutionContext;
    await expect(new JwtAuthGuard(prisma).canActivate(ctx(inA))).resolves.toBe(true);
    await expect(new JwtAuthGuard(prisma).canActivate(ctx(inB))).rejects.toMatchObject({ status: 428 });
  });

  it('aceptar en B con el token de A no es posible: la aceptación va siempre al workspace del token', async () => {
    const prisma = fakeRegistrationDb({ workspaceMember: members });
    await new LegalService(prisma).accept(inA, { acceptedTerms: currentTerms(), workspaceId: 'ws-b' } as any, META);
    expect(prisma.__store.termsAcceptance.some((r: any) => r.workspaceId === 'ws-b')).toBe(false);
  });
});

describe('Argos C2: excepciones del 428 por ruta exacta (no por sufijo)', () => {
  const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER', email: 'owner@example.com' } as any;

  it.each([
    '/api/v1/patients/legal/terms',
    '/api/v1/patients/abc/legal/terms/accept',
    '/api/v1/documents/auth/logout',
    '/api/v1/messages/x/auth/mfa/setup',
    '/api/v1/foo/legal/terms/status',
    '/otro/api/v1/legal/terms',
    '/api/v2/legal/terms',
    '/legal/terms',
    '/api/v1/legal/terms/accept/../../patients',
  ])('%s solo termina igual → NO queda exenta (428)', async (path) => {
    expect(isTermsPendingAllowedPath(path)).toBe(false);
    const prisma = fakeRegistrationDb({ termsAcceptance: [] });
    const error = await assertTermsAccepted(prisma, owner, path).catch((e) => e);
    expect(error?.getStatus?.()).toBe(428);
  });

  it.each([
    '/api/v1/legal/terms',
    '/api/v1/legal/terms/status',
    '/api/v1/legal/terms/accept',
    '/api/v1/auth/logout',
    '/api/v1/auth/mfa/setup',
    '/api/v1/auth/mfa/confirm',
    '/api/v1/legal/terms/status?x=1',
    '/api/v1/legal/terms/accept/',
    '/API/V1/Legal/Terms',
  ])('%s es una ruta exenta exacta (normalizada) → pasa sin aceptar', async (path) => {
    expect(isTermsPendingAllowedPath(path)).toBe(true);
    await expect(assertTermsAccepted(fakeRegistrationDb({ termsAcceptance: [] }), owner, path)).resolves.toBeUndefined();
  });

  it('normalizeRequestPath quita query, fragmento y barras finales y pasa a minúsculas', () => {
    expect(normalizeRequestPath('/API/v1/Legal/Terms//?a=1#x')).toBe('/api/v1/legal/terms');
    expect(normalizeRequestPath('')).toBe('/');
  });

  it('el código ya no decide la excepción con endsWith', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'legal', 'terms-acceptance.ts'), 'utf8');
    expect(src).not.toMatch(/endsWith\(/);
  });
});
