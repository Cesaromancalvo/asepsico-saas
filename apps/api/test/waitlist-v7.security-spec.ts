import { INestApplication, LoggerService, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import request = require('supertest');
import { decryptField } from '../src/common/crypto/field-encryption';
import { applyTrustProxy } from '../src/config/trust-proxy';
import { PrismaService } from '../src/database/prisma.service';
import { setWaitlistPhone } from '../src/waitlist/waitlist-admin';
import { hashWaitlistEmail, issueFormToken } from '../src/waitlist/waitlist-crypto';
import { WaitlistOriginGuard } from '../src/waitlist/waitlist-origin.guard';
import { waitlistBodyParser } from '../src/waitlist/waitlist-body.middleware';
import { WaitlistController } from '../src/waitlist/waitlist.controller';
import { WaitlistService } from '../src/waitlist/waitlist.service';
import { ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS, CURRENT_WAITLIST_PRIVACY_POLICY_VERSION, WAITLIST_PATH } from '../src/waitlist/waitlist.config';

/**
 * Política lista-espera-v7 (decisión del Jefe del 09/11/2026: el teléfono vuelve a ser obligatorio;
 * texto legal de Lex Psi en redacción). Datos 100 % ficticios.
 *  - v7 (vigente): teléfono obligatorio (E.164, cifrado), SIN campo de preferencia (si llega → 400
 *    WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED) y se guarda PHONE_AND_EMAIL.
 *  - v5 y v6 retiradas desde el 16/11/2026 (sin transición; sus variables se ignoran): ver
 *    waitlist-retired-v5-v6.security-spec.
 *  - Ni el teléfono, ni el email, ni la preferencia salen en logs ni en las respuestas.
 */

const ENC = /^enc:v[12]:/;
const LANDING = 'https://asepsico.es';
const URL = '/api/v1/public/waitlist';
const EMAIL = 'v7.ficticia@example.com';
const PHONE = '612 000 888';
const PHONE_E164 = '+34612000888';

const v7Body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Profesional Ficticia V7',
  email: EMAIL,
  situation: 'PRACTICE',
  phone: PHONE,
  privacyAccepted: true,
  privacyPolicyVersion: 'lista-espera-v7',
  formToken: issueFormToken(Date.now() - 10_000),
  ...overrides,
});

class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push = (...args: unknown[]) => { this.lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  log = this.push; error = this.push; warn = this.push; debug = this.push; verbose = this.push; fatal = this.push;
}

function mockPrisma() {
  const rows = new Map<string, any>();
  const create = jest.fn(async (args: any) => {
    if (args.data.emailHash && rows.has(args.data.emailHash)) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`emailHash`)', { code: 'P2002', clientVersion: 'test' });
    }
    const row = { id: `wl-${rows.size + 1}`, ...args.data };
    rows.set(args.data.emailHash, row);
    return row;
  });
  const forbidden = () => jest.fn(async () => { throw new Error('el alta pública no debe actualizar filas'); });
  return { rows, waitlistEntry: { create, upsert: forbidden(), update: forbidden(), updateMany: forbidden() } } as any;
}

async function buildApp(prisma: any, logger: LoggerService): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
    controllers: [WaitlistController],
    providers: [WaitlistService, WaitlistOriginGuard, { provide: PrismaService, useValue: prisma }, { provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();
  const app = moduleRef.createNestApplication({ logger });
  app.setGlobalPrefix('api/v1');
  applyTrustProxy(app.getHttpAdapter().getInstance(), { NODE_ENV: 'test', TRUST_PROXY: 'loopback' });
  app.use(WAITLIST_PATH, waitlistBodyParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  return app;
}

let ip = 0;
const post = (app: INestApplication, body: unknown) =>
  request(app.getHttpServer()).post(URL).set('Origin', LANDING).set('X-Forwarded-For', `192.0.2.${(ip++ % 250) + 1}`).send(body as object);

describe('Alta v7: teléfono obligatorio y sin preferencia (POST /public/waitlist)', () => {
  let app: INestApplication;
  let prisma: any;
  let logger: CapturingLogger;

  beforeEach(async () => {
    prisma = mockPrisma();
    logger = new CapturingLogger();
    app = await buildApp(prisma, logger);
  });
  afterEach(async () => {
    const logs = logger.lines.join('\n');
    expect(logs).not.toMatch(/612.?000.?888|\+34612000888/);
    expect(logs).not.toMatch(/EMAIL_ONLY|PHONE_AND_EMAIL/);
    expect(logs).not.toContain(EMAIL);
    await app.close();
  });

  it('la vigente es la v7 y es la única que pasa el filtro como aceptada', () => {
    expect(CURRENT_WAITLIST_PRIVACY_POLICY_VERSION).toBe('lista-espera-v7');
    expect([...ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS]).toEqual(['lista-espera-v7']);
  });

  it('v7 con teléfono → 202, cifrado en E.164, se guarda lista-espera-v7 y PHONE_AND_EMAIL', async () => {
    const res = await post(app, v7Body()).expect(202);
    expect(res.body).toEqual({ status: 'accepted' });
    const { data } = prisma.waitlistEntry.create.mock.calls[0][0];
    expect(data.privacyPolicyVersion).toBe('lista-espera-v7');
    expect(data.contactPreference).toBe('PHONE_AND_EMAIL');
    expect(data.phone).toMatch(ENC);
    expect(decryptField(data.phone)).toBe(PHONE_E164);
    expect(JSON.stringify(data)).not.toContain('612000888');
  });

  it.each([['sin phone', undefined], ['cadena vacía', ''], ['solo espacios', '   '], ['null', null]])('v7 %s → 400 WAITLIST_PHONE_REQUIRED, sin create', async (_label, phone) => {
    const res = await post(app, v7Body({ phone })).expect(400);
    expect(res.body).toEqual({ statusCode: 400, code: 'WAITLIST_PHONE_REQUIRED', message: expect.any(String) });
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it.each(['900 123 456', '701 234 567', '612a00888', '+1 2'])('v7 con teléfono no válido %j → 400 WAITLIST_PHONE_INVALID sin el valor en la respuesta', async (phone) => {
    const res = await post(app, v7Body({ phone })).expect(400);
    expect(res.body).toEqual({ statusCode: 400, code: 'WAITLIST_PHONE_INVALID', message: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain(phone.replace(/\s/g, '').slice(0, 5));
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it.each([
    ['EMAIL_ONLY sin teléfono', { contactPreference: 'EMAIL_ONLY', phone: undefined }],
    ['EMAIL_ONLY con teléfono', { contactPreference: 'EMAIL_ONLY' }],
    ['PHONE_AND_EMAIL con teléfono', { contactPreference: 'PHONE_AND_EMAIL' }],
    ['PHONE_AND_EMAIL sin teléfono', { contactPreference: 'PHONE_AND_EMAIL', phone: undefined }],
  ])('v7 con contactPreference (%s) → 400 WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED, sin create', async (_label, overrides) => {
    const res = await post(app, v7Body(overrides)).expect(400);
    expect(res.body).toEqual({ statusCode: 400, code: 'WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED', message: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/612|000 888/);
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it.each([
    ['un token falso', () => 'token-falso', 'WAITLIST_FORM_TOKEN_INVALID'],
    ['un token con la firma alterada', () => `${issueFormToken(Date.now() - 10_000)}x`, 'WAITLIST_FORM_TOKEN_INVALID'],
    ['un token caducado', () => issueFormToken(Date.now() - 3 * 60 * 60_000), 'WAITLIST_FORM_TOKEN_INVALID'],
    ['un token recién emitido (demasiado rápido)', () => issueFormToken(), 'WAITLIST_FORM_TOO_FAST'],
  ])('v7 con contactPreference y %s → 400 WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED (la preferencia se rechaza antes que el token)', async (_label, makeToken, tokenCode) => {
    const formToken = makeToken();
    for (const contactPreference of ['EMAIL_ONLY', 'PHONE_AND_EMAIL']) {
      const res = await post(app, v7Body({ contactPreference, formToken })).expect(400);
      expect(res.body).toEqual({ statusCode: 400, code: 'WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED', message: expect.any(String) });
    }
    // Control: sin la preferencia, ese mismo token sí es lo que falla.
    expect((await post(app, v7Body({ formToken })).expect(400)).body.code).toBe(tokenCode);
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it.each([null, '', 'PHONE', 'email_only', true])('v7 con una preferencia que no es del enum %j → 400 de validación, sin create', async (contactPreference) => {
    expect((await post(app, v7Body({ contactPreference }))).status).toBe(400);
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('v7 + commercialConsentRequested:true → 400 WAITLIST_COMMERCIAL_NOT_OFFERED', async () => {
    expect((await post(app, v7Body({ commercialConsentRequested: true })).expect(400)).body.code).toBe('WAITLIST_COMMERCIAL_NOT_OFFERED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('un email ya apuntado (fila v6 sin teléfono) que se reapunta con la v7 → 202 y la fila existente no cambia', async () => {
    const stored = { id: 'wl-v6', emailHash: hashWaitlistEmail(EMAIL), phone: null, contactPreference: 'EMAIL_ONLY', privacyPolicyVersion: 'lista-espera-v6' };
    prisma.rows.set(stored.emailHash, { ...stored });
    await post(app, v7Body()).expect(202);
    expect(prisma.rows.size).toBe(1);
    expect([...prisma.rows.values()][0]).toEqual(stored);
    expect(prisma.waitlistEntry.update).not.toHaveBeenCalled();
    expect(prisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
  });
});

describe('set-phone sobre una fila v6 «Solo por email» (Lex Psi, v7 §4)', () => {
  it('la pasa a PHONE_AND_EMAIL con el teléfono cifrado, sin filtrar por preferencia ni cambiar la versión, y audita sin datos', async () => {
    const tx = {
      waitlistEntry: {
        findFirst: jest.fn(async () => ({ id: 'cl0000000000000000000007' })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      platformAuditLog: { create: jest.fn(async () => ({})) },
    };
    const prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) } as any;
    expect(await setWaitlistPhone(prisma, EMAIL, PHONE)).toBe('updated');
    const { where, data } = tx.waitlistEntry.updateMany.mock.calls[0][0] as any;
    expect(where).toEqual({ id: 'cl0000000000000000000007', deletedAt: null });
    expect(data.contactPreference).toBe('PHONE_AND_EMAIL');
    expect(decryptField(data.phone)).toBe(PHONE_E164);
    expect(data).not.toHaveProperty('privacyPolicyVersion');
    expect(tx.platformAuditLog.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tx.platformAuditLog.create.mock.calls)).not.toMatch(/612|EMAIL_ONLY|PHONE_AND_EMAIL|contactPreference/);
    expect(JSON.stringify(tx.platformAuditLog.create.mock.calls)).not.toContain(EMAIL);
  });
});
