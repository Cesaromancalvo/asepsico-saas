import { INestApplication, LoggerService, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import request = require('supertest');
import { decryptField } from '../src/common/crypto/field-encryption';
import { applyTrustProxy } from '../src/config/trust-proxy';
import { PrismaService } from '../src/database/prisma.service';
import { MailService } from '../src/mail/mail.service';
import { clearWaitlistPhoneByEmail, clearWaitlistPhoneById, setWaitlistPhone } from '../src/waitlist/waitlist-admin';
import { issueFormToken } from '../src/waitlist/waitlist-crypto';
import { WaitlistNotifier } from '../src/waitlist/waitlist-notifier';
import { WaitlistOriginGuard } from '../src/waitlist/waitlist-origin.guard';
import { waitlistBodyParser } from '../src/waitlist/waitlist-body.middleware';
import { WaitlistController } from '../src/waitlist/waitlist.controller';
import { WaitlistService } from '../src/waitlist/waitlist.service';
import {
  ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS, CURRENT_WAITLIST_PRIVACY_POLICY_VERSION, RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS,
  RETIRED_WAITLIST_TRANSITION_ENV_VARS, WAITLIST_PATH, assertWaitlistConfig, isWaitlistPolicyVersionAccepted, retiredWaitlistEnvVarsSet,
} from '../src/waitlist/waitlist.config';
import * as waitlistConfig from '../src/waitlist/waitlist.config';

/**
 * Retirada de las políticas lista-espera-v5 (transición hasta el 12/11/2026) y lista-espera-v6
 * (transición hasta el 15/11/2026). Desde el 16/11/2026 solo se acepta la v7. Datos 100 % ficticios.
 *  - Un alta v5 o v6, con cualquier forma (con o sin teléfono, con o sin preferencia), → 400
 *    WAITLIST_POLICY_VERSION_RETIRED, sin create.
 *  - WAITLIST_V5_ACCEPTED_UNTIL / WAITLIST_V6_ACCEPTED_UNTIL se IGNORAN: con cualquier valor (futura,
 *    pasada, a más de 7 días o mal escrita) ni reabren la versión ni impiden arrancar. Solo se avisa,
 *    con el nombre de la variable y nunca su valor.
 *  - L15 y set-phone siguen manteniendo la preferencia coherente en las filas existentes (también las v6).
 *  - Ni el teléfono, ni el email, ni la preferencia salen en logs ni en las respuestas.
 */

const ENC = /^enc:v[12]:/;
const LANDING = 'https://asepsico.es';
const URL = '/api/v1/public/waitlist';
const EMAIL = 'v6.ficticia@example.com';
const PHONE = '612 000 777';
const PHONE_E164 = '+34612000777';
const DAY = 24 * 60 * 60_000;

const v7Body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Profesional Ficticia Retiradas',
  email: EMAIL,
  situation: 'SELF_EMPLOYED',
  phone: PHONE,
  privacyAccepted: true,
  privacyPolicyVersion: 'lista-espera-v7',
  formToken: issueFormToken(Date.now() - 10_000),
  ...overrides,
});

/** Las formas que enviaban los formularios v5 y v6 (y combinaciones que no casaban). */
const RETIRED_SHAPES: Array<[string, Record<string, unknown>]> = [
  ['v6 «Solo por email» sin teléfono', { privacyPolicyVersion: 'lista-espera-v6', contactPreference: 'EMAIL_ONLY', phone: undefined }],
  ['v6 «Solo por email» con teléfono', { privacyPolicyVersion: 'lista-espera-v6', contactPreference: 'EMAIL_ONLY' }],
  ['v6 «Por teléfono y por email» con teléfono', { privacyPolicyVersion: 'lista-espera-v6', contactPreference: 'PHONE_AND_EMAIL' }],
  ['v6 «Por teléfono y por email» sin teléfono', { privacyPolicyVersion: 'lista-espera-v6', contactPreference: 'PHONE_AND_EMAIL', phone: undefined }],
  ['v6 sin preferencia', { privacyPolicyVersion: 'lista-espera-v6' }],
  ['v6 con teléfono no válido', { privacyPolicyVersion: 'lista-espera-v6', contactPreference: 'PHONE_AND_EMAIL', phone: '900 123 456' }],
  ['v5 con teléfono', { privacyPolicyVersion: 'lista-espera-v5' }],
  ['v5 sin teléfono', { privacyPolicyVersion: 'lista-espera-v5', phone: undefined }],
  ['v5 con preferencia', { privacyPolicyVersion: 'lista-espera-v5', contactPreference: 'EMAIL_ONLY' }],
];

/** Valores que podrían quedar en Render: ninguno reabre nada ni impide arrancar. */
const LEFTOVER_VALUES: Array<[string, string | undefined]> = [
  ['sin variable', undefined],
  ['vacía', ''],
  ['la fecha de producción de la v6', '2026-11-15T23:59:59+01:00'],
  ['la fecha de producción de la v5', '2026-11-12T23:59:59+01:00'],
  ['una fecha futura dentro de 7 días', new Date(Date.now() + 3 * DAY).toISOString()],
  ['una fecha a más de 7 días', new Date(Date.now() + 30 * DAY).toISOString()],
  ['una fecha ya pasada', new Date(Date.now() - DAY).toISOString()],
  ['mal escrita', 'la semana que viene'],
];

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
  request(app.getHttpServer()).post(URL).set('Origin', LANDING).set('X-Forwarded-For', `198.51.100.${(ip++ % 250) + 1}`).send(body as object);

type RetiredVar = (typeof RETIRED_WAITLIST_TRANSITION_ENV_VARS)[number];
const previous = { v5: process.env.WAITLIST_V5_ACCEPTED_UNTIL, v6: process.env.WAITLIST_V6_ACCEPTED_UNTIL };
const setEnv = (name: RetiredVar, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
afterAll(() => {
  setEnv('WAITLIST_V5_ACCEPTED_UNTIL', previous.v5);
  setEnv('WAITLIST_V6_ACCEPTED_UNTIL', previous.v6);
});

/** Solo Date queda falso (timers, nextTick, etc. reales): supertest y Nest funcionan igual. */
const freezeDate = (iso: string) => jest.useFakeTimers({
  now: new Date(iso),
  doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
});

describe('v5 y v6 retiradas: listas de versiones', () => {
  it('la vigente es la v7, la única que se acepta; v1–v6 retiradas', () => {
    expect(CURRENT_WAITLIST_PRIVACY_POLICY_VERSION).toBe('lista-espera-v7');
    expect([...ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS]).toEqual(['lista-espera-v7']);
    expect([...RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS]).toEqual([
      'lista-espera-v1', 'lista-espera-v2', 'lista-espera-v3', 'lista-espera-v4', 'lista-espera-v5', 'lista-espera-v6',
    ]);
  });

  it('no queda ningún mecanismo de transición exportado (ni la tabla ni las lecturas de las variables)', () => {
    for (const name of ['WAITLIST_POLICY_TRANSITIONS', 'waitlistTransitionUntil', 'waitlistV5AcceptedUntil', 'waitlistV6AcceptedUntil', 'isTransitionalWaitlistPolicyVersion']) {
      expect(waitlistConfig).not.toHaveProperty(name);
    }
  });
});

describe('Alta v5/v6 retirada por HTTP (POST /public/waitlist)', () => {
  let app: INestApplication;
  let prisma: any;
  let logger: CapturingLogger;

  beforeEach(async () => {
    setEnv('WAITLIST_V5_ACCEPTED_UNTIL', undefined);
    setEnv('WAITLIST_V6_ACCEPTED_UNTIL', undefined);
    prisma = mockPrisma();
    logger = new CapturingLogger();
    app = await buildApp(prisma, logger);
  });
  afterEach(async () => {
    const logs = logger.lines.join('\n');
    expect(logs).not.toMatch(/612.?000.?777|\+34612000777/);
    expect(logs).not.toMatch(/EMAIL_ONLY|PHONE_AND_EMAIL/);
    expect(logs).not.toContain(EMAIL);
    setEnv('WAITLIST_V5_ACCEPTED_UNTIL', undefined);
    setEnv('WAITLIST_V6_ACCEPTED_UNTIL', undefined);
    await app.close();
    jest.useRealTimers();
  });

  it.each(RETIRED_SHAPES)('%s → 400 WAITLIST_POLICY_VERSION_RETIRED, sin create ni datos en la respuesta', async (_label, overrides) => {
    const res = await post(app, v7Body(overrides)).expect(400);
    expect(res.body).toEqual({ statusCode: 400, code: 'WAITLIST_POLICY_VERSION_RETIRED', message: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/612|000 777/);
    expect(JSON.stringify(res.body)).not.toContain(EMAIL);
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it.each(LEFTOVER_VALUES)('con las dos variables retiradas puestas (%s): la v5 y la v6 siguen retiradas y la v7 funciona', async (_label, value) => {
    setEnv('WAITLIST_V5_ACCEPTED_UNTIL', value);
    setEnv('WAITLIST_V6_ACCEPTED_UNTIL', value);
    for (const [, overrides] of RETIRED_SHAPES) {
      expect((await post(app, v7Body(overrides)).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    }
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
    await post(app, v7Body()).expect(202);
    expect(prisma.waitlistEntry.create).toHaveBeenCalledTimes(1);
    expect(prisma.waitlistEntry.create.mock.calls[0][0].data.privacyPolicyVersion).toBe('lista-espera-v7');
  });

  it('dentro de la antigua ventana de la v6 (10/11/2026, con su variable): la v6 ya está retirada', async () => {
    freezeDate('2026-11-10T10:00:00Z');
    setEnv('WAITLIST_V6_ACCEPTED_UNTIL', '2026-11-15T23:59:59+01:00');
    setEnv('WAITLIST_V5_ACCEPTED_UNTIL', '2026-11-12T23:59:59+01:00');
    expect((await post(app, v7Body({ privacyPolicyVersion: 'lista-espera-v6', contactPreference: 'EMAIL_ONLY', phone: undefined })).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect((await post(app, v7Body({ privacyPolicyVersion: 'lista-espera-v5' })).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('una v6 retirada se rechaza antes de mirar el token (página antigua en caché → recargar)', async () => {
    for (const formToken of ['token-falso', issueFormToken()]) {
      const res = await post(app, v7Body({ privacyPolicyVersion: 'lista-espera-v6', contactPreference: 'EMAIL_ONLY', phone: undefined, formToken })).expect(400);
      expect(res.body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    }
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });
});

describe('Configuración: las variables de la v5 y la v6 se ignoran y nunca impiden arrancar', () => {
  const base: NodeJS.ProcessEnv = { NODE_ENV: 'production', WAITLIST_SECRET: 'x'.repeat(40) };

  it.each(LEFTOVER_VALUES)('assertWaitlistConfig no falla con WAITLIST_V5/V6_ACCEPTED_UNTIL = %s', (_label, value) => {
    const env: NodeJS.ProcessEnv = { ...base };
    if (value !== undefined) {
      env.WAITLIST_V5_ACCEPTED_UNTIL = value;
      env.WAITLIST_V6_ACCEPTED_UNTIL = value;
    }
    expect(() => assertWaitlistConfig(env)).not.toThrow();
  });

  it('el resto de la configuración se sigue comprobando igual (no se relaja nada)', () => {
    expect(() => assertWaitlistConfig({ NODE_ENV: 'production', WAITLIST_V6_ACCEPTED_UNTIL: '2026-11-15T23:59:59+01:00' })).toThrow(/WAITLIST_SECRET/);
    expect(() => assertWaitlistConfig({ ...base, WAITLIST_ALLOWED_ORIGINS: 'http://asepsico.es', WAITLIST_V6_ACCEPTED_UNTIL: 'x' })).toThrow(/WAITLIST_ALLOWED_ORIGINS/);
  });

  it('retiredWaitlistEnvVarsSet devuelve solo los NOMBRES de las variables puestas (nunca sus valores)', () => {
    expect([...RETIRED_WAITLIST_TRANSITION_ENV_VARS]).toEqual(['WAITLIST_V5_ACCEPTED_UNTIL', 'WAITLIST_V6_ACCEPTED_UNTIL']);
    expect(retiredWaitlistEnvVarsSet({ ...base })).toEqual([]);
    expect(retiredWaitlistEnvVarsSet({ ...base, WAITLIST_V5_ACCEPTED_UNTIL: '', WAITLIST_V6_ACCEPTED_UNTIL: '   ' })).toEqual([]);
    expect(retiredWaitlistEnvVarsSet({ ...base, WAITLIST_V6_ACCEPTED_UNTIL: '2026-11-15T23:59:59+01:00' })).toEqual(['WAITLIST_V6_ACCEPTED_UNTIL']);
    const both = retiredWaitlistEnvVarsSet({ ...base, WAITLIST_V5_ACCEPTED_UNTIL: 'valor-secreto-ficticio', WAITLIST_V6_ACCEPTED_UNTIL: '2026-11-15T23:59:59+01:00' });
    expect(both).toEqual(['WAITLIST_V5_ACCEPTED_UNTIL', 'WAITLIST_V6_ACCEPTED_UNTIL']);
    expect(JSON.stringify(both)).not.toMatch(/valor-secreto-ficticio|2026-11-15/);
  });

  it('isWaitlistPolicyVersionAccepted: solo la v7, sin depender del reloj ni del entorno', () => {
    process.env.WAITLIST_V6_ACCEPTED_UNTIL = new Date(Date.now() + 3 * DAY).toISOString();
    process.env.WAITLIST_V5_ACCEPTED_UNTIL = new Date(Date.now() + 3 * DAY).toISOString();
    try {
      expect(isWaitlistPolicyVersionAccepted('lista-espera-v7')).toBe(true);
      for (const v of ['lista-espera-v1', 'lista-espera-v4', 'lista-espera-v5', 'lista-espera-v6', 'lista-espera-v8', 'LISTA-ESPERA-V7', ' lista-espera-v7', 'constructor', '__proto__', 'toString']) {
        expect(isWaitlistPolicyVersionAccepted(v)).toBe(false);
      }
    } finally {
      setEnv('WAITLIST_V5_ACCEPTED_UNTIL', undefined);
      setEnv('WAITLIST_V6_ACCEPTED_UNTIL', undefined);
    }
  });
});

describe('L15 y set-phone mantienen la preferencia coherente en las filas existentes (sin la preferencia en la auditoría)', () => {
  const txPrisma = (count: number, exists = 1) => {
    const tx = {
      waitlistEntry: {
        findFirst: jest.fn(async () => ({ id: 'cl0000000000000000000001' })),
        updateMany: jest.fn(async () => ({ count })),
        count: jest.fn(async () => exists),
      },
      platformAuditLog: { create: jest.fn(async () => ({})) },
    };
    return { tx, prisma: { $transaction: jest.fn(async (fn: any) => fn(tx)) } as any };
  };

  it('borrar el teléfono (panel y CLI) deja phone = null y EMAIL_ONLY, y solo actúa sobre filas CON teléfono', async () => {
    const { tx } = txPrisma(1);
    expect(await clearWaitlistPhoneById(tx as any, 'cl0000000000000000000001')).toBe('cleared');
    const args = tx.waitlistEntry.updateMany.mock.calls[0][0] as any;
    expect(args.data).toEqual({ phone: null, contactPreference: 'EMAIL_ONLY' });
    expect(args.where).toEqual({ id: 'cl0000000000000000000001', deletedAt: null, phone: { not: null } });
  });

  it('condición 3 de Argos: fila activa SIN teléfono (aunque diga PHONE_AND_EMAIL) → no-phone, sin escribir ni auditar', async () => {
    const { tx, prisma } = txPrisma(0, 1);
    expect(await clearWaitlistPhoneById(tx as any, 'cl0000000000000000000001')).toBe('no-phone');
    expect(await clearWaitlistPhoneByEmail(prisma, EMAIL)).toBe('no-phone');
    expect(tx.platformAuditLog.create).not.toHaveBeenCalled();
  });

  it('CLI --clear: auditoría sin teléfono, email ni preferencia', async () => {
    const { tx, prisma } = txPrisma(1);
    expect(await clearWaitlistPhoneByEmail(prisma, EMAIL)).toBe('cleared');
    const audit = JSON.stringify(tx.platformAuditLog.create.mock.calls);
    expect(audit).not.toMatch(/EMAIL_ONLY|PHONE_AND_EMAIL|contactPreference/);
    expect(audit).not.toContain(EMAIL);
  });

  it('una fila ya EMAIL_ONLY y sin teléfono → no-phone, sin auditoría', async () => {
    const { tx, prisma } = txPrisma(0, 1);
    expect(await clearWaitlistPhoneByEmail(prisma, EMAIL)).toBe('no-phone');
    expect(tx.platformAuditLog.create).not.toHaveBeenCalled();
  });

  it('set-phone cifra el teléfono y pone PHONE_AND_EMAIL; la auditoría no lleva la preferencia', async () => {
    const { tx, prisma } = txPrisma(1);
    expect(await setWaitlistPhone(prisma, EMAIL, PHONE)).toBe('updated');
    const { data } = tx.waitlistEntry.updateMany.mock.calls[0][0] as any;
    expect(data.contactPreference).toBe('PHONE_AND_EMAIL');
    expect(data.phone).toMatch(ENC);
    expect(decryptField(data.phone)).toBe(PHONE_E164);
    expect(JSON.stringify(tx.platformAuditLog.create.mock.calls)).not.toMatch(/PHONE_AND_EMAIL|contactPreference|612/);
  });
});

describe('Aviso interno de altas: sin la preferencia ni el teléfono', () => {
  it('alta v7: el correo enviado no menciona la preferencia ni el teléfono', async () => {
    const env: NodeJS.ProcessEnv = {
      MAIL_SMTP_HOST: 'smtp.example.test', MAIL_SMTP_PORT: '587', MAIL_SMTP_USER: 'proyecto-ficticio', MAIL_SMTP_PASSWORD: 'clave-ficticia',
      MAIL_FROM: 'AsePsico <avisos@example.test>', WAITLIST_NOTIFY_TO: 'jefe@example.test', WAITLIST_NOTIFY_ENABLED: 'true',
    };
    const send = jest.fn(async () => undefined);
    const mail = new MailService(env, () => ({ send }));
    const prisma: any = { waitlistEntry: { create: jest.fn(async () => ({ id: 'w-1' })), count: jest.fn(async () => 2) } };
    const notifier = new WaitlistNotifier(prisma, mail, env);
    await new WaitlistService(prisma, notifier).submit(v7Body() as any);
    await notifier.flush();
    notifier.onModuleDestroy();
    expect(prisma.waitlistEntry.create.mock.calls[0][0].data.contactPreference).toBe('PHONE_AND_EMAIL');
    expect(send).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify((send.mock.calls as unknown[][])[0]);
    expect(sent).not.toMatch(/EMAIL_ONLY|PHONE_AND_EMAIL|preferencia|solo (por )?email|tel[eé]fono|612/i);
  });
});
