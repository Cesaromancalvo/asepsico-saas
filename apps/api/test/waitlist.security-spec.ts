import { Controller, Get, INestApplication, LoggerService, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request = require('supertest');
import { buildCorsDelegate, isWaitlistPath } from '../src/config/cors';
import { applyTrustProxy } from '../src/config/trust-proxy';
import { decryptField } from '../src/common/crypto/field-encryption';
import { PrismaService } from '../src/database/prisma.service';
import { WaitlistController } from '../src/waitlist/waitlist.controller';
import { WaitlistOriginGuard } from '../src/waitlist/waitlist-origin.guard';
import { WaitlistService } from '../src/waitlist/waitlist.service';
import { checkFormToken, hashWaitlistEmail, issueFormToken } from '../src/waitlist/waitlist-crypto';
import { csvCell, deleteWaitlistEntry, resolveExportPath, waitlistCsv } from '../src/waitlist/waitlist-admin';
import { InvalidWaitlistConfigError, assertWaitlistConfig, parseWaitlistOrigins } from '../src/waitlist/waitlist.config';

/**
 * Lista de espera pública (POST /api/v1/public/waitlist). Datos 100 % ficticios.
 * Se monta la app con la MISMA configuración que main.ts (prefijo, ValidationPipe, CORS por ruta,
 * ThrottlerGuard global, trust proxy) y un Prisma simulado que registra las escrituras.
 */

const ENC = /^enc:v[12]:/;
const LANDING = 'https://asepsico.es';
const APP_ORIGIN = 'https://app.example.test';
const URL = '/api/v1/public/waitlist';
const NAME = 'Profesional Ficticia Prueba';
const EMAIL = 'ficticia.prueba@example.com';
const TOOLS = 'Agenda en papel y hoja de cálculo ficticia';

const validBody = (overrides: Record<string, unknown> = {}) => ({
  name: NAME,
  email: EMAIL,
  situation: 'SELF_EMPLOYED',
  tools: TOOLS,
  professionalsCount: 3,
  source: 'COLLEAGUE',
  privacyAccepted: true,
  privacyPolicyVersion: 'lista-espera-v2',
  commercialConsent: false,
  formToken: issueFormToken(Date.now() - 10_000),
  ...overrides,
});

@Controller('patients-probe')
class OtherEndpointProbe {
  @Get() list() { return []; }
}

class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push = (...args: unknown[]) => { this.lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  log = this.push; error = this.push; warn = this.push; debug = this.push; verbose = this.push; fatal = this.push;
}

function mockPrisma() {
  const upsert = jest.fn(async (args: any) => ({ id: 'wl-1', ...args.create }));
  return { waitlistEntry: { upsert } } as any;
}

/**
 * trustLoopback: supertest conecta desde 127.0.0.1; confiando en él, cada petición puede simular
 * una IP de cliente distinta con X-Forwarded-For (así el rate limit no interfiere con el resto de
 * tests). El test de rate limit usa trustLoopback=false: ahí X-Forwarded-For se ignora.
 */
async function buildApp(prisma: any, logger?: LoggerService, trustLoopback = true): Promise<INestApplication> {
  const env = { ...process.env, WEB_ORIGIN: APP_ORIGIN, WAITLIST_ALLOWED_ORIGINS: '' };
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
    controllers: [WaitlistController, OtherEndpointProbe],
    providers: [WaitlistService, WaitlistOriginGuard, { provide: PrismaService, useValue: prisma }, { provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();
  const app = moduleRef.createNestApplication(logger ? { logger } : { logger: false });
  app.setGlobalPrefix('api/v1');
  applyTrustProxy(app.getHttpAdapter().getInstance(), { NODE_ENV: 'test', TRUST_PROXY: trustLoopback ? 'loopback' : 'false' });
  app.enableCors(buildCorsDelegate(env));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  return app;
}

let ipCounter = 0;
const nextClientIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

const post = (app: INestApplication, body: unknown, origin: string | null = LANDING) => {
  const req = request(app.getHttpServer()).post(URL).set('X-Forwarded-For', nextClientIp());
  if (origin) req.set('Origin', origin);
  return req.send(body as object);
};

describe('Lista de espera: alta, validación y anti-abuso', () => {
  let app: INestApplication;
  let prisma: any;

  beforeEach(async () => {
    prisma = mockPrisma();
    app = await buildApp(prisma);
  });
  afterEach(() => app.close());

  it('alta válida → 202 genérico y escritura con nombre, email y herramientas cifrados', async () => {
    const res = await post(app, validBody()).expect(202);
    expect(res.body).toEqual({ status: 'accepted' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(prisma.waitlistEntry.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.waitlistEntry.upsert.mock.calls[0][0];
    for (const data of [args.create, args.update]) {
      for (const [field, plain] of [['name', NAME], ['email', EMAIL], ['tools', TOOLS]] as const) {
        expect(data[field]).toMatch(ENC);
        expect(data[field]).not.toContain(plain);
        expect(decryptField(data[field])).toBe(plain);
      }
      expect(data.privacyPolicyVersion).toBe('lista-espera-v2');
      expect(data.privacyAcceptedAt).toBeInstanceOf(Date);
      expect(data.commercialConsent).toBe(false);
      expect(data.commercialConsentAt).toBeNull();
      // Ni IP ni user-agent ni nada que no sea del formulario.
      expect(Object.keys(data)).not.toEqual(expect.arrayContaining(['ip']));
      expect(JSON.stringify(data)).not.toMatch(/127\.0\.0\.1|::1|supertest|userAgent/i);
    }
    expect(args.where).toEqual({ emailHash: hashWaitlistEmail(EMAIL) });
    expect(args.create.emailHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('el consentimiento comercial se guarda con fecha solo si se marca', async () => {
    await post(app, validBody({ commercialConsent: true })).expect(202);
    const { create } = prisma.waitlistEntry.upsert.mock.calls[0][0];
    expect(create.commercialConsent).toBe(true);
    expect(create.commercialConsentAt).toBeInstanceOf(Date);
  });

  it.each([
    ['campo no declarado', { isAdmin: true }],
    ['workspaceId inyectado', { workspaceId: 'ws-1' }],
    ['deletedAt inyectado', { deletedAt: null }],
    ['nombre demasiado largo', { name: 'x'.repeat(121) }],
    ['nombre vacío', { name: '   ' }],
    ['email inválido', { email: 'no-es-un-email' }],
    ['email demasiado largo', { email: `${'a'.repeat(250)}@example.com` }],
    ['herramientas demasiado largas', { tools: 'x'.repeat(501) }],
    ['situación fuera del enum', { situation: 'ADMIN' }],
    ['fuente fuera del enum', { source: 'TIKTOK' }],
    ['nº de profesionales 0', { professionalsCount: 0 }],
    ['nº de profesionales no entero', { professionalsCount: 2.5 }],
    ['consentimiento comercial no booleano', { commercialConsent: 'sí' }],
    ['honeypot demasiado largo', { website: 'x'.repeat(501) }],
  ])('400 por validación/whitelist: %s', async (_label, overrides) => {
    const res = await post(app, validBody(overrides)).expect(400);
    expect(JSON.stringify(res.body)).not.toContain(EMAIL);
    expect(prisma.waitlistEntry.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['sin aceptar la política (false)', { privacyAccepted: false }],
    ['sin el campo de aceptación', { privacyAccepted: undefined }],
    ['aceptación como texto', { privacyAccepted: 'true' }],
    ['versión de política antigua', { privacyPolicyVersion: 'lista-espera-v1' }],
    ['sin versión de política', { privacyPolicyVersion: undefined }],
  ])('400 si no se acepta la política vigente: %s', async (_label, overrides) => {
    await post(app, validBody(overrides)).expect(400);
    expect(prisma.waitlistEntry.upsert).not.toHaveBeenCalled();
  });

  it('email repetido (con otras mayúsculas/espacios) → misma respuesta y actualiza la misma fila', async () => {
    const first = await post(app, validBody()).expect(202);
    const second = await post(app, validBody({ email: `  ${EMAIL.toUpperCase()} `, name: 'Otro Nombre Ficticio' })).expect(202);
    expect(second.body).toEqual(first.body);
    expect(second.headers['content-length']).toBe(first.headers['content-length']);
    const [a, b] = prisma.waitlistEntry.upsert.mock.calls.map((c: any[]) => c[0]);
    expect(b.where).toEqual(a.where);
    expect(decryptField(b.update.name)).toBe('Otro Nombre Ficticio');
  });

  it('honeypot relleno → misma respuesta 202 y no se guarda nada', async () => {
    const ok = await post(app, validBody()).expect(202);
    prisma.waitlistEntry.upsert.mockClear();
    const res = await post(app, validBody({ website: 'https://spam.example' })).expect(202);
    expect(res.body).toEqual(ok.body);
    expect(prisma.waitlistEntry.upsert).not.toHaveBeenCalled();
  });

  it('tiempo mínimo de rellenado: token recién emitido → 400 WAITLIST_FORM_TOO_FAST', async () => {
    const res = await post(app, validBody({ formToken: issueFormToken() })).expect(400);
    expect(res.body.code).toBe('WAITLIST_FORM_TOO_FAST');
    expect(prisma.waitlistEntry.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['sin token', { formToken: undefined }, 400],
    ['token inventado', { formToken: `${Date.now() - 10_000}.abc.firmafalsa` }, 400],
    ['token manipulado (fecha cambiada)', { formToken: issueFormToken(Date.now() - 10_000).replace(/^\d+/, String(Date.now() - 20_000)) }, 400],
    ['token caducado', { formToken: issueFormToken(Date.now() - 3 * 60 * 60 * 1000) }, 400],
  ])('token de formulario inválido: %s', async (_label, overrides, status) => {
    await post(app, validBody(overrides)).expect(status);
    expect(prisma.waitlistEntry.upsert).not.toHaveBeenCalled();
  });

  it('GET form-token devuelve un token válido que aún no se puede usar', async () => {
    const res = await request(app.getHttpServer()).get(`${URL}/form-token`).set('Origin', LANDING).expect(200);
    expect(res.body).toEqual({ formToken: expect.any(String), minSeconds: 3 });
    expect(checkFormToken(res.body.formToken)).toBe('too-fast');
    expect(checkFormToken(res.body.formToken, Date.now() + 4_000)).toBe('ok');
  });
});

describe('Lista de espera: CORS y origen', () => {
  let app: INestApplication;
  let prisma: any;

  beforeAll(async () => {
    prisma = mockPrisma();
    app = await buildApp(prisma);
  });
  afterAll(() => app.close());
  beforeEach(() => prisma.waitlistEntry.upsert.mockClear());

  it.each([LANDING, 'https://www.asepsico.es'])('preflight desde %s: permitido, sin credenciales', async (origin) => {
    const res = await request(app.getHttpServer())
      .options(URL).set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST');
  });

  it.each(['https://evil.example', 'https://asepsico.es.evil.example', 'http://asepsico.es', APP_ORIGIN, 'null'])(
    'origen no permitido %s: sin cabeceras CORS en el preflight y 403 en el POST, sin escribir nada',
    async (origin) => {
      const pre = await request(app.getHttpServer())
        .options(URL).set('Origin', origin).set('Access-Control-Request-Method', 'POST');
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
      const res = await post(app, validBody(), origin).expect(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(prisma.waitlistEntry.upsert).not.toHaveBeenCalled();
    },
  );

  it('sin cabecera Origin (petición que no viene de un navegador en la landing) → 403', async () => {
    await post(app, validBody(), null).expect(403);
    expect(prisma.waitlistEntry.upsert).not.toHaveBeenCalled();
  });

  it('el origen de la landing NO obtiene CORS en otros endpoints; la app conserva el suyo con credenciales', async () => {
    // El CORS de la app es un origen fijo: responde siempre WEB_ORIGIN, nunca el de la landing.
    const fromLanding = await request(app.getHttpServer()).get('/api/v1/patients-probe').set('Origin', LANDING);
    expect(fromLanding.headers['access-control-allow-origin']).not.toBe(LANDING);
    const preflight = await request(app.getHttpServer())
      .options('/api/v1/patients-probe').set('Origin', LANDING).set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).not.toBe(LANDING);
    const fromApp = await request(app.getHttpServer()).get('/api/v1/patients-probe').set('Origin', APP_ORIGIN);
    expect(fromApp.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(fromApp.headers['access-control-allow-credentials']).toBe('true');
  });

  it('isWaitlistPath solo reconoce la ruta exacta y sus subrutas', () => {
    expect(isWaitlistPath(URL)).toBe(true);
    expect(isWaitlistPath(`${URL}/form-token?x=1`)).toBe(true);
    expect(isWaitlistPath(`${URL}-admin`)).toBe(false);
    expect(isWaitlistPath('/api/v1/patients')).toBe(false);
  });

  it('configuración de orígenes: rechaza comodines, rutas, http en producción y listas mal escritas', () => {
    expect(parseWaitlistOrigins('', 'production')).toEqual(['https://asepsico.es', 'https://www.asepsico.es']);
    expect(parseWaitlistOrigins('https://asepsico.es, http://localhost:8080', 'development')).toEqual(['https://asepsico.es', 'http://localhost:8080']);
    for (const bad of ['*', 'https://asepsico.es/form', 'asepsico.es', 'https://asepsico.es,,', 'ftp://asepsico.es']) {
      expect(() => parseWaitlistOrigins(bad, 'development')).toThrow(InvalidWaitlistConfigError);
    }
    expect(() => parseWaitlistOrigins('http://asepsico.es', 'production')).toThrow(InvalidWaitlistConfigError);
  });

  it('WAITLIST_SECRET es obligatorio en producción y debe ser largo', () => {
    expect(() => assertWaitlistConfig({ NODE_ENV: 'production' })).toThrow(/WAITLIST_SECRET/);
    expect(() => assertWaitlistConfig({ NODE_ENV: 'production', WAITLIST_SECRET: 'corto' })).toThrow(/32/);
    expect(() => assertWaitlistConfig({ NODE_ENV: 'production', WAITLIST_SECRET: 'x'.repeat(40) })).not.toThrow();
  });
});

describe('Lista de espera: rate limit por IP', () => {
  let app: INestApplication;

  beforeAll(async () => { app = await buildApp(mockPrisma(), undefined, false); });
  afterAll(() => app.close());

  it('5 envíos por IP cada 10 min; el 6.º es 429 aunque se cambie X-Forwarded-For', async () => {
    for (let i = 0; i < 5; i++) {
      await post(app, validBody({ email: `ficticia${i}@example.com` })).set('X-Forwarded-For', `203.0.113.${i}`).expect(202);
    }
    await post(app, validBody({ email: 'ficticia9@example.com' })).set('X-Forwarded-For', '198.51.100.7').expect(429);
  });
});

describe('Lista de espera: nada de datos personales en los logs', () => {
  it('ni nombre, ni email, ni herramientas, ni hash, ni IP en ningún camino (alta, repetida, honeypot, errores, fallo de BD)', async () => {
    const logger = new CapturingLogger();
    const prisma = mockPrisma();
    const stdout = jest.spyOn(process.stdout, 'write');
    const stderr = jest.spyOn(process.stderr, 'write');
    const app = await buildApp(prisma, logger);
    try {
      await post(app, validBody()).expect(202);
      await post(app, validBody()).expect(202);
      await post(app, validBody({ website: 'relleno' })).expect(202);
      await post(app, validBody({ formToken: issueFormToken() })).expect(400);
      await post(app, validBody({ formToken: 'roto' })).expect(400);
      await post(app, validBody({ privacyAccepted: false })).expect(400);
      await post(app, validBody({ email: 'no-valido' })).expect(400);
      await post(app, validBody(), 'https://evil.example').expect(403);
      prisma.waitlistEntry.upsert.mockRejectedValueOnce(new Error(`Unique constraint failed: ${EMAIL} ${NAME}`));
      await post(app, validBody()).expect(500);
    } finally {
      await app.close();
    }
    const written = [
      ...logger.lines,
      ...stdout.mock.calls.map((c) => String(c[0])),
      ...stderr.mock.calls.map((c) => String(c[0])),
    ].join('\n');
    stdout.mockRestore();
    stderr.mockRestore();
    expect(logger.lines.some((l) => l.includes('Alta en la lista de espera registrada'))).toBe(true);
    expect(logger.lines.some((l) => l.includes('error de base de datos'))).toBe(true);
    for (const secret of [NAME, EMAIL, EMAIL.split('@')[0], TOOLS, hashWaitlistEmail(EMAIL), '127.0.0.1', '198.51.100.', 'evil.example']) {
      expect({ secret, leaked: written.includes(secret) }).toEqual({ secret, leaked: false });
    }
  });
});

describe('Lista de espera: cifrado en reposo, exportación y supresión', () => {
  it('la exportación CSV descifra y neutraliza fórmulas', async () => {
    const prisma = mockPrisma();
    await new WaitlistService(prisma).submit(validBody({ name: '=HYPERLINK("http://x")', tools: 'Excel, "papel"' }) as any);
    const stored = prisma.waitlistEntry.upsert.mock.calls[0][0].create;
    expect(stored.name).toMatch(ENC);
    const { csv, unreadable } = waitlistCsv([stored]);
    expect(unreadable).toBe(0);
    expect(csv).toContain(EMAIL);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain('"Excel, ""papel"""');
    expect(csv).not.toMatch(/enc:v[12]:/);
    expect(csvCell('+34 600')).toBe("'+34 600");
    expect(csvCell(null)).toBe('');
  });

  it('la ruta del export debe quedar fuera del repositorio', () => {
    const repo = resolve(__dirname, '../../..');
    expect(() => resolveExportPath(undefined, repo)).toThrow(/--out/);
    expect(() => resolveExportPath('lista.csv', repo, join(repo, 'apps/api'))).toThrow(/dentro del repositorio/);
    expect(() => resolveExportPath(join(repo, 'docs/lista.csv'), repo)).toThrow(/dentro del repositorio/);
    const outside = mkdtempSync(join(tmpdir(), 'waitlist-'));
    expect(resolveExportPath(join(outside, 'lista.csv'), repo)).toBe(join(outside, 'lista.csv'));
  });

  it('la supresión busca por hash y vacía todos los datos personales, incluido el hash', async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const count = await deleteWaitlistEntry({ waitlistEntry: { updateMany } } as any, ` ${EMAIL.toUpperCase()}`);
    expect(count).toBe(1);
    const [args] = (updateMany.mock.calls[0] as any[]);
    expect(args.where).toEqual({ emailHash: hashWaitlistEmail(EMAIL), deletedAt: null });
    expect(args.data).toMatchObject({ name: null, email: null, emailHash: null, tools: null, professionalsCount: null, situation: null, source: null, commercialConsent: false, commercialConsentAt: null });
    expect(args.data.deletedAt).toBeInstanceOf(Date);
  });

  it('el hash del email es un HMAC con clave: no coincide con un SHA-256 simple y cambia con el secreto', () => {
    const { createHash } = require('node:crypto');
    const plainSha = createHash('sha256').update(EMAIL).digest('hex');
    expect(hashWaitlistEmail(EMAIL)).not.toBe(plainSha);
    expect(hashWaitlistEmail(EMAIL, { WAITLIST_SECRET: 'a'.repeat(40) })).not.toBe(hashWaitlistEmail(EMAIL, { WAITLIST_SECRET: 'b'.repeat(40) }));
  });
});
