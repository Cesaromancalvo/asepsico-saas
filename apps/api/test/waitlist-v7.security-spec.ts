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
import { issueFormToken } from '../src/waitlist/waitlist-crypto';
import { WaitlistOriginGuard } from '../src/waitlist/waitlist-origin.guard';
import { waitlistBodyParser } from '../src/waitlist/waitlist-body.middleware';
import { WaitlistController } from '../src/waitlist/waitlist.controller';
import { WaitlistService } from '../src/waitlist/waitlist.service';
import {
  ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS, CURRENT_WAITLIST_PRIVACY_POLICY_VERSION, InvalidWaitlistConfigError, WAITLIST_PATH,
  WAITLIST_TRANSITION_MAX_DAYS, assertWaitlistConfig, isWaitlistPolicyVersionAccepted, waitlistV6AcceptedUntil,
} from '../src/waitlist/waitlist.config';

/**
 * Política lista-espera-v7 (decisión del Jefe del 09/11/2026: el teléfono vuelve a ser obligatorio;
 * texto legal de Lex Psi en redacción). Datos 100 % ficticios.
 *  - v7 (vigente): teléfono obligatorio (E.164, cifrado), SIN campo de preferencia (si llega → 400
 *    WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED) y se guarda PHONE_AND_EMAIL.
 *  - v6: solo en transición (WAITLIST_V6_ACCEPTED_UNTIL, máx. 7 días), con sus reglas (preferencia
 *    obligatoria; EMAIL_ONLY sin teléfono). Fuera de plazo → WAITLIST_POLICY_VERSION_RETIRED.
 *  - Coordinación con la v5: v5 retirada tras su fecha (tope fijo 12/11/2026), v6 en transición y v7
 *    vigente, cada transición con su variable y su límite de 7 días.
 *  - Ni el teléfono, ni el email, ni la preferencia salen en logs ni en las respuestas.
 */

const ENC = /^enc:v[12]:/;
const LANDING = 'https://asepsico.es';
const URL = '/api/v1/public/waitlist';
const EMAIL = 'v7.ficticia@example.com';
const PHONE = '612 000 888';
const PHONE_E164 = '+34612000888';
const DAY = 24 * 60 * 60_000;

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

const v6Body = (overrides: Record<string, unknown> = {}) => {
  const { phone: _omit, ...body } = v7Body({ privacyPolicyVersion: 'lista-espera-v6', contactPreference: 'EMAIL_ONLY' });
  return { ...body, ...overrides };
};

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

const previous = { v5: process.env.WAITLIST_V5_ACCEPTED_UNTIL, v6: process.env.WAITLIST_V6_ACCEPTED_UNTIL };
const setEnv = (name: 'WAITLIST_V5_ACCEPTED_UNTIL' | 'WAITLIST_V6_ACCEPTED_UNTIL', value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const setV6Until = (value: string | undefined) => setEnv('WAITLIST_V6_ACCEPTED_UNTIL', value);
afterAll(() => {
  setEnv('WAITLIST_V5_ACCEPTED_UNTIL', previous.v5);
  setEnv('WAITLIST_V6_ACCEPTED_UNTIL', previous.v6);
});

describe('Alta v7: teléfono obligatorio y sin preferencia (POST /public/waitlist)', () => {
  let app: INestApplication;
  let prisma: any;
  let logger: CapturingLogger;

  beforeEach(async () => {
    setEnv('WAITLIST_V5_ACCEPTED_UNTIL', undefined);
    setV6Until(undefined);
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

  it('la vigente es la v7 y pasan el filtro v5, v6 y v7', () => {
    expect(CURRENT_WAITLIST_PRIVACY_POLICY_VERSION).toBe('lista-espera-v7');
    expect([...ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS]).toEqual(['lista-espera-v5', 'lista-espera-v6', 'lista-espera-v7']);
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

  it.each([null, '', 'PHONE', 'email_only', true])('v7 con una preferencia que no es del enum %j → 400 de validación, sin create', async (contactPreference) => {
    expect((await post(app, v7Body({ contactPreference }))).status).toBe(400);
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('v7 + commercialConsentRequested:true → 400 WAITLIST_COMMERCIAL_NOT_OFFERED', async () => {
    expect((await post(app, v7Body({ commercialConsentRequested: true })).expect(400)).body.code).toBe('WAITLIST_COMMERCIAL_NOT_OFFERED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('un email ya apuntado (fila v6 sin teléfono) que se reapunta con la v7 → 202 y la fila existente no cambia', async () => {
    setV6Until(new Date(Date.now() + 3 * DAY).toISOString());
    await post(app, v6Body()).expect(202);
    setV6Until(undefined);
    const stored = { ...[...prisma.rows.values()][0] };
    expect(stored.phone).toBeNull();
    await post(app, v7Body()).expect(202);
    expect(prisma.rows.size).toBe(1);
    expect([...prisma.rows.values()][0]).toEqual(stored);
    expect(prisma.waitlistEntry.update).not.toHaveBeenCalled();
    expect(prisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['sin variable', undefined],
    ['con la fecha ya pasada', new Date(Date.now() - 1000).toISOString()],
    ['mal escrita', 'dentro de una semana'],
  ])('v6 fuera de su transición (%s) → 400 WAITLIST_POLICY_VERSION_RETIRED, con cualquier preferencia', async (_label, until) => {
    setV6Until(until);
    expect((await post(app, v6Body()).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect((await post(app, v6Body({ contactPreference: 'PHONE_AND_EMAIL', phone: PHONE })).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });
});

describe('Transición de la v6 (WAITLIST_V6_ACCEPTED_UNTIL) por HTTP', () => {
  let app: INestApplication;
  let prisma: any;

  beforeEach(async () => {
    setV6Until(new Date(Date.now() + 3 * DAY).toISOString());
    prisma = mockPrisma();
    app = await buildApp(prisma, new CapturingLogger());
  });
  afterEach(async () => {
    setV6Until(undefined);
    await app.close();
  });

  it('v6 «Solo por email» dentro del plazo → 202, phone null, EMAIL_ONLY y se guarda lista-espera-v6', async () => {
    await post(app, v6Body()).expect(202);
    const { data } = prisma.waitlistEntry.create.mock.calls[0][0];
    expect(data).toMatchObject({ privacyPolicyVersion: 'lista-espera-v6', contactPreference: 'EMAIL_ONLY', phone: null });
  });

  it('v6 «Por teléfono y por email» dentro del plazo → 202 con teléfono cifrado', async () => {
    await post(app, v6Body({ contactPreference: 'PHONE_AND_EMAIL', phone: PHONE })).expect(202);
    const { data } = prisma.waitlistEntry.create.mock.calls[0][0];
    expect(data.contactPreference).toBe('PHONE_AND_EMAIL');
    expect(decryptField(data.phone)).toBe(PHONE_E164);
  });

  it('dentro del plazo la v6 conserva sus reglas: sin preferencia → REQUIRED; EMAIL_ONLY con teléfono → NOT_ALLOWED', async () => {
    const { contactPreference: _omit, ...noPref } = v6Body();
    expect((await post(app, noPref).expect(400)).body.code).toBe('WAITLIST_CONTACT_PREFERENCE_REQUIRED');
    expect((await post(app, v6Body({ phone: PHONE })).expect(400)).body.code).toBe('WAITLIST_PHONE_NOT_ALLOWED');
    expect((await post(app, v6Body({ contactPreference: 'PHONE_AND_EMAIL' })).expect(400)).body.code).toBe('WAITLIST_PHONE_REQUIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('durante la transición de la v6 la v7 sigue exigiendo teléfono y rechazando la preferencia', async () => {
    expect((await post(app, v7Body({ phone: undefined })).expect(400)).body.code).toBe('WAITLIST_PHONE_REQUIRED');
    expect((await post(app, v7Body({ contactPreference: 'EMAIL_ONLY', phone: undefined })).expect(400)).body.code).toBe('WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('abrir la v6 no reabre la v5 (cada versión tiene su variable)', async () => {
    setEnv('WAITLIST_V5_ACCEPTED_UNTIL', undefined);
    const { contactPreference: _omit, ...v5 } = v6Body({ privacyPolicyVersion: 'lista-espera-v5', phone: PHONE });
    expect((await post(app, v5).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
  });

  it('pasada la fecha, la v6 se rechaza como retirada', async () => {
    setV6Until(new Date(Date.now() - 1000).toISOString());
    expect((await post(app, v6Body()).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });
});

describe('Configuración: v5 retirada tras su fecha, v6 en transición y v7 vigente', () => {
  const base: NodeJS.ProcessEnv = { NODE_ENV: 'production', WAITLIST_SECRET: 'x'.repeat(40) };
  const env = (vars: { v5?: string; v6?: string } = {}): NodeJS.ProcessEnv => ({
    ...base,
    ...(vars.v5 !== undefined ? { WAITLIST_V5_ACCEPTED_UNTIL: vars.v5 } : {}),
    ...(vars.v6 !== undefined ? { WAITLIST_V6_ACCEPTED_UNTIL: vars.v6 } : {}),
  });
  const accepted = (version: string, at: string, e: NodeJS.ProcessEnv) => isWaitlistPolicyVersionAccepted(version, new Date(at), e);

  it('el límite de las transiciones es de 7 días', () => {
    expect(WAITLIST_TRANSITION_MAX_DAYS).toBe(7);
  });

  it('sin variables: la v6 y la v5 retiradas, la v7 aceptada y la API arranca', () => {
    const now = new Date('2026-11-10T10:00:00Z');
    expect(waitlistV6AcceptedUntil(env())).toBeNull();
    expect(waitlistV6AcceptedUntil(env({ v6: '  ' }))).toBeNull();
    expect(() => assertWaitlistConfig(env(), now)).not.toThrow();
    expect(isWaitlistPolicyVersionAccepted('lista-espera-v7', now, env())).toBe(true);
    expect(isWaitlistPolicyVersionAccepted('lista-espera-v6', now, env())).toBe(false);
    expect(isWaitlistPolicyVersionAccepted('lista-espera-v5', now, env())).toBe(false);
  });

  it('WAITLIST_V6_ACCEPTED_UNTIL hasta 7 días: arranca y acepta la v6 solo antes de la fecha', () => {
    const now = new Date('2026-11-10T10:00:00Z');
    const e = env({ v6: '2026-11-17T10:00:00Z' });
    expect(() => assertWaitlistConfig(e, now)).not.toThrow();
    expect(accepted('lista-espera-v6', '2026-11-17T09:59:59Z', e)).toBe(true);
    expect(accepted('lista-espera-v6', '2026-11-17T10:00:00Z', e)).toBe(false);
  });

  it('WAITLIST_V6_ACCEPTED_UNTIL a más de 7 días o mal escrita: la API no arranca (y la de la v5 sigue igual)', () => {
    const now = new Date('2026-11-10T10:00:00Z');
    expect(() => assertWaitlistConfig(env({ v6: '2026-11-17T10:00:01Z' }), now)).toThrow(/WAITLIST_V6_ACCEPTED_UNTIL/);
    for (const bad of ['2026-11-15', '15/11/2026', '2026-11-15T10:00:00', 'mañana', '2026-13-40T10:00:00Z']) {
      expect(() => assertWaitlistConfig(env({ v6: bad }), now)).toThrow(InvalidWaitlistConfigError);
    }
    expect(() => assertWaitlistConfig(env({ v5: '2026-11-17T10:00:01Z', v6: '2026-11-12T10:00:00Z' }), now)).toThrow(/WAITLIST_V5_ACCEPTED_UNTIL/);
  });

  it('las dos transiciones a la vez (v7 publicada el 11/11): cada una cierra en su fecha', () => {
    const e = env({ v5: '2026-11-12T23:59:59+01:00', v6: '2026-11-18T12:00:00+01:00' });
    expect(() => assertWaitlistConfig(e, new Date('2026-11-11T12:00:00Z'))).not.toThrow();
    // 11/11: v5, v6 y v7.
    expect(['lista-espera-v5', 'lista-espera-v6', 'lista-espera-v7'].map((v) => accepted(v, '2026-11-11T12:00:00Z', e))).toEqual([true, true, true]);
    // 13/11: la v5 retirada (su fecha y su tope fijo); la v6 sigue en transición.
    expect(['lista-espera-v5', 'lista-espera-v6', 'lista-espera-v7'].map((v) => accepted(v, '2026-11-13T08:00:00Z', e))).toEqual([false, true, true]);
    // 19/11: solo la v7.
    expect(['lista-espera-v5', 'lista-espera-v6', 'lista-espera-v7'].map((v) => accepted(v, '2026-11-19T08:00:00Z', e))).toEqual([false, false, true]);
    // Un reinicio el 15/11 con la variable vencida de la v5 todavía puesta arranca igual.
    expect(() => assertWaitlistConfig(e, new Date('2026-11-15T08:00:00Z'))).not.toThrow();
  });

  it('plan del Jefe: v7 publicada el 09/11, v5 hasta el 12/11 23:59 y v6 hasta el 15/11 23:59 (+01:00)', () => {
    const e = env({ v5: '2026-11-12T23:59:59+01:00', v6: '2026-11-15T23:59:59+01:00' });
    // Arranca el día de la publicación, aunque sea a última hora, y en cualquier reinicio posterior.
    for (const boot of ['2026-11-09T08:00:00+01:00', '2026-11-09T23:59:00+01:00', '2026-11-12T10:00:00+01:00', '2026-11-20T10:00:00+01:00']) {
      expect(() => assertWaitlistConfig(e, new Date(boot))).not.toThrow();
    }
    const at = (when: string) => ['lista-espera-v5', 'lista-espera-v6', 'lista-espera-v7'].map((v) => accepted(v, when, e));
    expect(at('2026-11-09T12:00:00+01:00')).toEqual([true, true, true]);
    expect(at('2026-11-12T23:59:58+01:00')).toEqual([true, true, true]);
    expect(at('2026-11-12T23:59:59+01:00')).toEqual([false, true, true]);
    expect(at('2026-11-15T23:59:58+01:00')).toEqual([false, true, true]);
    expect(at('2026-11-15T23:59:59+01:00')).toEqual([false, false, true]);
    expect(at('2026-11-16T09:00:00+01:00')).toEqual([false, false, true]);
  });

  it('con la v7 publicada el 09/11, la v6 hasta el 16/11 23:59 no cabe en los 7 días: la API no arranca', () => {
    const boot = new Date('2026-11-09T12:00:00+01:00');
    expect(() => assertWaitlistConfig(env({ v6: '2026-11-16T23:59:59+01:00' }), boot)).toThrow(/WAITLIST_V6_ACCEPTED_UNTIL/);
    // Ni una variable de la v5 alargada más allá de su tope amplía nada (y a +7 días tampoco arranca).
    expect(accepted('lista-espera-v5', '2026-11-13T09:00:00+01:00', env({ v5: '2026-11-14T09:00:00+01:00' }))).toBe(false);
  });

  it('una variable de la v6 mal escrita, leída en caliente, nunca amplía lo aceptado', () => {
    expect(accepted('lista-espera-v6', '2026-11-10T10:00:00Z', env({ v6: 'la semana que viene' }))).toBe(false);
  });

  it('versiones desconocidas o con otra grafía nunca, ni con las dos transiciones abiertas', () => {
    const e = env({ v5: '2026-11-12T23:59:59+01:00', v6: '2026-11-16T10:00:00Z' });
    for (const v of ['lista-espera-v1', 'lista-espera-v4', 'lista-espera-v8', 'LISTA-ESPERA-V7', 'LISTA-ESPERA-V6', ' lista-espera-v6', 'constructor', '__proto__', 'toString']) {
      expect(accepted(v, '2026-11-10T10:00:00Z', e)).toBe(false);
    }
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
