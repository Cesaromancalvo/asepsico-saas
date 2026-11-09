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
  CURRENT_WAITLIST_PRIVACY_POLICY_VERSION, InvalidWaitlistConfigError, WAITLIST_PATH, assertWaitlistConfig,
  WAITLIST_POLICY_TRANSITIONS, isWaitlistPolicyVersionAccepted, waitlistV5AcceptedUntil,
} from '../src/waitlist/waitlist.config';

/**
 * Política lista-espera-v6 (Lex Psi, revisión 03/11/2026 §1.1, §1.4 y §7; decisión del Jefe del
 * 03/11: preferencia sin opción marcada por defecto). Desde la v7 (09/11/2026) la v6 solo se acepta en
 * transición (WAITLIST_V6_ACCEPTED_UNTIL; la v7 y esa transición: waitlist-v7.security-spec). Datos
 * 100 % ficticios.
 *  - v6: contactPreference obligatoria; PHONE_AND_EMAIL exige teléfono; EMAIL_ONLY lo prohíbe.
 *  - v5: solo en transición (WAITLIST_V5_ACCEPTED_UNTIL, máx. 7 días y nunca después del 12/11/2026),
 *    con teléfono y sin preferencia. Las pruebas HTTP de la v5 en plazo fijan el reloj (solo Date) en
 *    el 10/11/2026, para que no caduquen cuando pase el tope fijo.
 *  - L15: borrar el teléfono deja la preferencia en EMAIL_ONLY; set-phone la pone en PHONE_AND_EMAIL.
 *  - La preferencia no sale en logs, auditoría ni en el aviso interno.
 */

const ENC = /^enc:v[12]:/;
const LANDING = 'https://asepsico.es';
const URL = '/api/v1/public/waitlist';
const EMAIL = 'v6.ficticia@example.com';
const PHONE = '612 000 777';
const PHONE_E164 = '+34612000777';
const DAY = 24 * 60 * 60_000;

const v6Body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Profesional Ficticia V6',
  email: EMAIL,
  situation: 'SELF_EMPLOYED',
  contactPreference: 'EMAIL_ONLY',
  privacyAccepted: true,
  privacyPolicyVersion: 'lista-espera-v6',
  formToken: issueFormToken(Date.now() - 10_000),
  ...overrides,
});

const v5Body = (overrides: Record<string, unknown> = {}) => {
  const { contactPreference: _omit, ...body } = v6Body({ privacyPolicyVersion: 'lista-espera-v5', phone: PHONE, ...overrides });
  return 'contactPreference' in overrides ? { ...body, contactPreference: overrides.contactPreference } : body;
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
  request(app.getHttpServer()).post(URL).set('Origin', LANDING).set('X-Forwarded-For', `198.51.100.${(ip++ % 250) + 1}`).send(body as object);

const previousUntil = process.env.WAITLIST_V5_ACCEPTED_UNTIL;
const previousV6Until = process.env.WAITLIST_V6_ACCEPTED_UNTIL;
const setEnv = (name: 'WAITLIST_V5_ACCEPTED_UNTIL' | 'WAITLIST_V6_ACCEPTED_UNTIL', value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const setV5Until = (value: string | undefined) => setEnv('WAITLIST_V5_ACCEPTED_UNTIL', value);
const setV6Until = (value: string | undefined) => setEnv('WAITLIST_V6_ACCEPTED_UNTIL', value);
afterAll(() => {
  setV5Until(previousUntil);
  setV6Until(previousV6Until);
});

/** Solo Date queda falso (timers, nextTick, etc. reales): supertest y Nest funcionan igual. */
const freezeDate = (iso: string) => jest.useFakeTimers({
  now: new Date(iso),
  doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
});

describe('Alta v6 en transición: preferencia de contacto y teléfono (POST /public/waitlist)', () => {
  let app: INestApplication;
  let prisma: any;
  let logger: CapturingLogger;

  // Reloj congelado dentro de la transición: la v6 tiene tope fijo (15/11/2026 23:59:59 +01:00).
  beforeEach(async () => {
    freezeDate('2026-11-10T10:00:00Z');
    setV5Until(undefined);
    setV6Until(new Date(Date.now() + 3 * DAY).toISOString());
    prisma = mockPrisma();
    logger = new CapturingLogger();
    app = await buildApp(prisma, logger);
  });
  afterEach(async () => {
    const logs = logger.lines.join('\n');
    expect(logs).not.toMatch(/612.?000.?777|\+34612000777/);
    expect(logs).not.toMatch(/EMAIL_ONLY|PHONE_AND_EMAIL/);
    expect(logs).not.toContain(EMAIL);
    setV6Until(undefined);
    await app.close();
    jest.useRealTimers();
  });

  it('la v6 ya no es la vigente (lo es la v7) y solo se acepta en transición, con tope fijo el 15/11/2026 23:59:59 (+01:00)', () => {
    expect(CURRENT_WAITLIST_PRIVACY_POLICY_VERSION).toBe('lista-espera-v7');
    expect(WAITLIST_POLICY_TRANSITIONS['lista-espera-v6']).toEqual({ envVar: 'WAITLIST_V6_ACCEPTED_UNTIL', hardEnd: new Date('2026-11-15T23:59:59+01:00') });
  });

  it('EMAIL_ONLY sin teléfono → 202, phone null y se guarda EMAIL_ONLY con la v6', async () => {
    await post(app, v6Body()).expect(202);
    const { data } = prisma.waitlistEntry.create.mock.calls[0][0];
    expect(data.phone).toBeNull();
    expect(data.contactPreference).toBe('EMAIL_ONLY');
    expect(data.privacyPolicyVersion).toBe('lista-espera-v6');
    expect(data.name).toMatch(ENC);
  });

  it.each([
    ['un teléfono válido', PHONE],
    ['una cadena vacía', ''],
    ['solo espacios', '   '],
    ['null', null],
    ['un teléfono no válido', '512 000 777'],
  ])('EMAIL_ONLY con %s → 400 WAITLIST_PHONE_NOT_ALLOWED, sin create ni el valor en la respuesta', async (_label, phone) => {
    const res = await post(app, v6Body({ phone })).expect(400);
    expect(res.body).toEqual({ statusCode: 400, code: 'WAITLIST_PHONE_NOT_ALLOWED', message: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/612|000 777/);
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('PHONE_AND_EMAIL con teléfono → 202, cifrado en E.164 y PHONE_AND_EMAIL', async () => {
    await post(app, v6Body({ contactPreference: 'PHONE_AND_EMAIL', phone: PHONE })).expect(202);
    const { data } = prisma.waitlistEntry.create.mock.calls[0][0];
    expect(data.phone).toMatch(ENC);
    expect(decryptField(data.phone)).toBe(PHONE_E164);
    expect(data.contactPreference).toBe('PHONE_AND_EMAIL');
    expect(JSON.stringify(data)).not.toContain('612000777');
  });

  it.each([['sin phone', undefined], ['cadena vacía', ''], ['solo espacios', '   '], ['null', null]])('PHONE_AND_EMAIL %s → 400 WAITLIST_PHONE_REQUIRED', async (_label, phone) => {
    const res = await post(app, v6Body({ contactPreference: 'PHONE_AND_EMAIL', phone })).expect(400);
    expect(res.body.code).toBe('WAITLIST_PHONE_REQUIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('PHONE_AND_EMAIL con formato no válido → 400 WAITLIST_PHONE_INVALID', async () => {
    const res = await post(app, v6Body({ contactPreference: 'PHONE_AND_EMAIL', phone: '900 123 456' })).expect(400);
    expect(res.body.code).toBe('WAITLIST_PHONE_INVALID');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it.each([['sin teléfono', undefined], ['con teléfono', PHONE]])('v6 sin preferencia (%s) → 400 WAITLIST_CONTACT_PREFERENCE_REQUIRED: no hay valor por defecto', async (_label, phone) => {
    const res = await post(app, v6Body({ contactPreference: undefined, phone })).expect(400);
    expect(res.body.code).toBe('WAITLIST_CONTACT_PREFERENCE_REQUIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it.each([null, '', 'PHONE', 'phone_and_email', 'email_only', true, 1, ['EMAIL_ONLY']])('preferencia no válida %j → 400 (nunca se asume una)', async (contactPreference) => {
    const res = await post(app, v6Body({ contactPreference, phone: PHONE }));
    expect(res.status).toBe(400);
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('v5 sin transición configurada → 400 WAITLIST_POLICY_VERSION_RETIRED (también sin teléfono)', async () => {
    expect((await post(app, v5Body()).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect((await post(app, v5Body({ phone: undefined })).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });
});

describe('Transición de la v5 (WAITLIST_V5_ACCEPTED_UNTIL)', () => {
  let app: INestApplication;
  let prisma: any;
  let logger: CapturingLogger;

  // 10/11/2026: dentro del tope fijo de la v5 (12/11/2026 23:59:59 +01:00).
  beforeEach(async () => {
    freezeDate('2026-11-10T10:00:00Z');
    setV5Until('2026-11-12T23:59:59+01:00');
    prisma = mockPrisma();
    logger = new CapturingLogger();
    app = await buildApp(prisma, logger);
  });
  afterEach(async () => {
    setV5Until(undefined);
    await app.close();
    jest.useRealTimers();
  });

  it('v5 con teléfono dentro del plazo → 202, se guarda lista-espera-v5 y PHONE_AND_EMAIL (su casilla consintió las llamadas)', async () => {
    await post(app, v5Body()).expect(202);
    const { data } = prisma.waitlistEntry.create.mock.calls[0][0];
    expect(data.privacyPolicyVersion).toBe('lista-espera-v5');
    expect(data.contactPreference).toBe('PHONE_AND_EMAIL');
    expect(decryptField(data.phone)).toBe(PHONE_E164);
  });

  it.each([['sin phone', undefined], ['cadena vacía', ''], ['null', null]])('nunca un alta v5 sin teléfono: %s → 400 WAITLIST_PHONE_REQUIRED', async (_label, phone) => {
    expect((await post(app, v5Body({ phone })).expect(400)).body.code).toBe('WAITLIST_PHONE_REQUIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it.each(['EMAIL_ONLY', 'PHONE_AND_EMAIL'])('v5 con contactPreference %s → 400 WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED (no se mezclan formularios)', async (contactPreference) => {
    expect((await post(app, v5Body({ contactPreference })).expect(400)).body.code).toBe('WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it.each(['lista-espera-v1', 'lista-espera-v2', 'lista-espera-v3', 'lista-espera-v4'])('durante la transición %s sigue retirada', async (privacyPolicyVersion) => {
    expect((await post(app, v5Body({ privacyPolicyVersion })).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('la v7 (vigente) funciona durante la transición de la v5; la v6 sin su variable, retirada', async () => {
    await post(app, v5Body({ privacyPolicyVersion: 'lista-espera-v7' })).expect(202);
    expect(prisma.waitlistEntry.create.mock.calls[0][0].data.privacyPolicyVersion).toBe('lista-espera-v7');
    expect((await post(app, v6Body({ email: 'v6.otra.ficticia@example.com' })).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
  });

  it('pasado el tope fijo (13/11/2026), la v5 se rechaza como retirada aunque la variable diga más', async () => {
    jest.setSystemTime(new Date('2026-11-13T00:00:30+01:00'));
    setV5Until('2026-11-14T23:59:59+01:00');
    expect((await post(app, v5Body()).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('pasada la fecha, la v5 se rechaza como retirada', async () => {
    setV5Until(new Date(Date.now() - 1000).toISOString());
    expect((await post(app, v5Body()).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('una fecha mal escrita no amplía nada: la v5 se rechaza', async () => {
    setV5Until('dentro de una semana');
    expect((await post(app, v5Body()).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
  });
});

describe('Configuración de la transición', () => {
  const now = new Date('2026-11-06T10:00:00Z');
  const env = (until?: string): NodeJS.ProcessEnv => ({ NODE_ENV: 'production', WAITLIST_SECRET: 'x'.repeat(40), ...(until !== undefined ? { WAITLIST_V5_ACCEPTED_UNTIL: until } : {}) });

  it('sin variable o vacía: la v5 está retirada y la API arranca', () => {
    expect(waitlistV5AcceptedUntil(env())).toBeNull();
    expect(waitlistV5AcceptedUntil(env('  '))).toBeNull();
    expect(() => assertWaitlistConfig(env(), now)).not.toThrow();
    expect(isWaitlistPolicyVersionAccepted('lista-espera-v5', now, env())).toBe(false);
  });

  it('hasta 7 días: arranca y acepta la v5 solo antes de la fecha', () => {
    const e = env('2026-11-13T10:00:00Z');
    expect(() => assertWaitlistConfig(e, now)).not.toThrow();
    expect(isWaitlistPolicyVersionAccepted('lista-espera-v5', now, e)).toBe(true);
    expect(isWaitlistPolicyVersionAccepted('lista-espera-v5', new Date('2026-11-13T10:00:00Z'), e)).toBe(false);
  });

  it('a más de 7 días o mal escrita: la API no arranca', () => {
    expect(() => assertWaitlistConfig(env('2026-11-13T10:00:01Z'), now)).toThrow(InvalidWaitlistConfigError);
    for (const bad of ['2026-11-10', '13/11/2026', '2026-11-10T10:00:00', 'mañana', '2026-13-40T10:00:00Z']) {
      expect(() => assertWaitlistConfig(env(bad), now)).toThrow(InvalidWaitlistConfigError);
    }
  });

  it('tope fijo de la v5: nunca después del 12/11/2026 23:59:59 (+01:00), y la API sigue arrancando', () => {
    expect(WAITLIST_POLICY_TRANSITIONS['lista-espera-v5'].hardEnd?.toISOString()).toBe('2026-11-12T22:59:59.000Z');
    const e = env('2026-11-15T10:00:00Z');
    const after = new Date('2026-11-12T23:00:00Z');
    expect(() => assertWaitlistConfig(e, after)).not.toThrow();
    expect(isWaitlistPolicyVersionAccepted('lista-espera-v5', after, e)).toBe(false);
    expect(isWaitlistPolicyVersionAccepted('lista-espera-v5', new Date('2026-11-12T22:59:58Z'), e)).toBe(true);
    // La variable antigua ya vencida no impide arrancar (puede quedarse en Render tras el 12/11).
    expect(() => assertWaitlistConfig(env('2026-11-12T23:59:59+01:00'), new Date('2026-11-20T10:00:00Z'))).not.toThrow();
  });

  it('la v7 siempre; v1–v4 y versiones desconocidas nunca, ni con transición', () => {
    const e = env('2026-11-08T10:00:00Z');
    expect(isWaitlistPolicyVersionAccepted('lista-espera-v7', now, env())).toBe(true);
    for (const v of ['lista-espera-v1', 'lista-espera-v2', 'lista-espera-v3', 'lista-espera-v4', 'lista-espera-v8', 'LISTA-ESPERA-V5']) {
      expect(isWaitlistPolicyVersionAccepted(v, now, e)).toBe(false);
    }
  });
});

describe('L15 y set-phone mantienen la preferencia coherente (sin la preferencia en la auditoría)', () => {
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

describe('Aviso interno de altas: sin la preferencia (v6 §6)', () => {
  it.each(['EMAIL_ONLY', 'PHONE_AND_EMAIL'])('alta %s: el correo enviado no menciona la preferencia ni el teléfono', async (contactPreference) => {
    freezeDate('2026-11-10T10:00:00Z'); // dentro de la transición de la v6 (tope fijo 15/11/2026)
    const env: NodeJS.ProcessEnv = {
      MAIL_SMTP_HOST: 'smtp.example.test', MAIL_SMTP_PORT: '587', MAIL_SMTP_USER: 'proyecto-ficticio', MAIL_SMTP_PASSWORD: 'clave-ficticia',
      MAIL_FROM: 'AsePsico <avisos@example.test>', WAITLIST_NOTIFY_TO: 'jefe@example.test', WAITLIST_NOTIFY_ENABLED: 'true',
    };
    const send = jest.fn(async () => undefined);
    const mail = new MailService(env, () => ({ send }));
    const prisma: any = { waitlistEntry: { create: jest.fn(async () => ({ id: 'w-1' })), count: jest.fn(async () => 2) } };
    const notifier = new WaitlistNotifier(prisma, mail, env);
    const body = contactPreference === 'EMAIL_ONLY' ? v6Body() : v6Body({ contactPreference, phone: PHONE });
    setV6Until(new Date(Date.now() + 3 * DAY).toISOString());
    try {
      await new WaitlistService(prisma, notifier).submit(body as any);
    } finally {
      setV6Until(undefined);
      jest.useRealTimers();
    }
    await notifier.flush();
    notifier.onModuleDestroy();
    expect(send).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify((send.mock.calls as unknown[][])[0]);
    expect(sent).not.toMatch(/EMAIL_ONLY|PHONE_AND_EMAIL|preferencia|solo (por )?email|tel[eé]fono|612/i);
  });
});
