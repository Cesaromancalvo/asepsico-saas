import { INestApplication, LoggerService, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request = require('supertest');
import { encryptModelData } from '../src/common/crypto/clinical-crypto';
import { decryptField } from '../src/common/crypto/field-encryption';
import { applyTrustProxy } from '../src/config/trust-proxy';
import { PrismaService } from '../src/database/prisma.service';
import { MailService } from '../src/mail/mail.service';
import { buildWaitlistResponse, PLATFORM_WAITLIST_SELECT, WaitlistRow } from '../src/platform/platform-waitlist.view';
import { WaitlistController } from '../src/waitlist/waitlist.controller';
import { WaitlistOriginGuard } from '../src/waitlist/waitlist-origin.guard';
import { WaitlistService } from '../src/waitlist/waitlist.service';
import { WaitlistNotifier, waitlistNotifyBody } from '../src/waitlist/waitlist-notifier';
import { issueFormToken } from '../src/waitlist/waitlist-crypto';
import { normalizeWaitlistPhone } from '../src/waitlist/waitlist-phone';
import { deleteWaitlistEntry, exportWaitlist, purgeWaitlist, suppressWaitlistEntryById, WAITLIST_CSV_COLUMNS, WAITLIST_CSV_COLUMNS_WITH_PHONE, waitlistCsv } from '../src/waitlist/waitlist-admin';
import { isLocalDatabaseUrl } from '../prisma/scripts/waitlist-script-utils';
import { spawnSync } from 'node:child_process';
import { ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS, WAITLIST_PATH } from '../src/waitlist/waitlist.config';
import { waitlistBodyParser } from '../src/waitlist/waitlist-body.middleware';

/**
 * Teléfono obligatorio en la lista de espera (política lista-espera-v5). Datos 100 % ficticios.
 * Criterios 1–7 y 10 de la spec de Vega, y §G de Lex (regla por versión, nada en logs ni aviso).
 */

const ENC = /^enc:v[12]:/;
const LANDING = 'https://asepsico.es';
const URL = '/api/v1/public/waitlist';
const EMAIL = 'telefono.ficticio@example.com';
const PHONE = '612 345 678';
const PHONE_E164 = '+34612345678';
const PHONE_DIGITS = '612345678';

const v5Body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Profesional Ficticia Telefono',
  email: EMAIL,
  phone: PHONE,
  situation: 'SELF_EMPLOYED',
  privacyAccepted: true,
  privacyPolicyVersion: 'lista-espera-v5',
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
  request(app.getHttpServer()).post(URL).set('Origin', LANDING).set('X-Forwarded-For', `203.0.113.${(ip++ % 250) + 1}`).send(body as object);

describe('Normalización del teléfono (criterios 2, 3 y 6)', () => {
  it.each([
    ['612 345 678', '+34612345678'],
    ['+34 612 345 678', '+34612345678'],
    ['0034612345678', '+34612345678'],
    ['34612345678', '+34612345678'],
    ['612.345.678', '+34612345678'],
    ['(+34) 612-345-678', '+34612345678'],
    ['912 345 678', '+34912345678'],
    ['744 123 456', '+34744123456'],
    ['812 345 678', '+34812345678'],
    ['612 345 678', '+34612345678'],
    ['+351 912 345 678', '+351912345678'],
    ['0044 20 7946 0000', '+442079460000'],
  ])('acepta %s → %s', (input, expected) => {
    expect(normalizeWaitlistPhone(input)).toBe(expected);
  });

  it.each([
    '512345678', '61234567', '6123456789', '900123456', '902123456', '701234567', '803123456', '806123456',
    '612a45678', '+34 512 345 678', '+34 900 123 456', '+34 61234567', '+1 2', '+0 123 456 789', '+1234567',
    '+1234567890123456', '', '+', '++34612345678', '612/345/678', '612_345_678', '612345678 ext 2', '34 612 345 67',
  ])('rechaza %j', (input) => {
    expect(normalizeWaitlistPhone(input)).toBeNull();
  });

  it('rechaza lo que no es una cadena o supera 25 caracteres', () => {
    expect(normalizeWaitlistPhone(612345678 as unknown)).toBeNull();
    expect(normalizeWaitlistPhone(null)).toBeNull();
    expect(normalizeWaitlistPhone(' '.repeat(17) + '612345678')).toBeNull();
  });

  it('la única versión aceptada es la v5, que informa del teléfono y lo exige', () => {
    expect([...ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS]).toEqual(['lista-espera-v5']);
  });
});

describe('Alta pública con teléfono (POST /public/waitlist)', () => {
  let app: INestApplication;
  let prisma: any;
  let logger: CapturingLogger;

  beforeEach(async () => {
    prisma = mockPrisma();
    logger = new CapturingLogger();
    app = await buildApp(prisma, logger);
  });
  afterEach(async () => {
    expect(logger.lines.join('\n')).not.toMatch(/612.?345.?678|\+34612|0034612/);
    await app.close();
  });

  it('criterio 1: v5 con teléfono → 202, se guarda cifrado y al descifrar vale E.164', async () => {
    await post(app, v5Body()).expect(202);
    const { data } = prisma.waitlistEntry.create.mock.calls[0][0];
    expect(data.phone).toMatch(ENC);
    expect(JSON.stringify(data)).not.toContain(PHONE_DIGITS);
    expect(decryptField(data.phone)).toBe(PHONE_E164);
    expect(data.privacyPolicyVersion).toBe('lista-espera-v5');
  });

  it.each(['+34 612 345 678', '0034612345678', '34612345678', '(+34) 612-345-678', '  612 345 678  '])('criterio 2: %j → +34612345678', async (phone) => {
    await post(app, v5Body({ phone })).expect(202);
    expect(decryptField(prisma.waitlistEntry.create.mock.calls[0][0].data.phone)).toBe(PHONE_E164);
  });

  it.each(['512345678', '900123456', '701234567', '612a45678', '+34 512 345 678', '+1 2'])('criterio 3/6: %j → 400 WAITLIST_PHONE_INVALID sin crear fila ni devolver el valor', async (phone) => {
    const res = await post(app, v5Body({ phone })).expect(400);
    expect(res.body).toEqual({ statusCode: 400, code: 'WAITLIST_PHONE_INVALID', message: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain(phone.replace(/\s/g, '').slice(1, 6));
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('criterio 6: internacional +351 se guarda como +351912345678', async () => {
    await post(app, v5Body({ phone: '+351 912 345 678' })).expect(202);
    expect(decryptField(prisma.waitlistEntry.create.mock.calls[0][0].data.phone)).toBe('+351912345678');
  });

  it.each([['sin phone', undefined], ['cadena vacía', ''], ['solo espacios', '   ']])('criterio 4: v5 %s → 400 WAITLIST_PHONE_REQUIRED', async (_label, phone) => {
    const res = await post(app, v5Body({ phone })).expect(400);
    expect(res.body.code).toBe('WAITLIST_PHONE_REQUIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it.each(['lista-espera-v2', 'lista-espera-v3', 'lista-espera-v4'])('versiones retiradas: %s con o sin phone → 400 WAITLIST_POLICY_VERSION_RETIRED, sin el teléfono en la respuesta', async (version) => {
    const withPhone = await post(app, v5Body({ privacyPolicyVersion: version })).expect(400);
    expect(withPhone.body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect(JSON.stringify(withPhone.body)).not.toContain(PHONE_DIGITS.slice(0, 5));
    const { phone: _omit, ...body } = v5Body({ privacyPolicyVersion: version });
    expect((await post(app, body).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect((await post(app, v5Body({ privacyPolicyVersion: version, phone: '' })).expect(400)).body.code).toBe('WAITLIST_POLICY_VERSION_RETIRED');
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('phone que no es cadena o de más de 25 caracteres → 400 de validación que nombra el campo, no el valor', async () => {
    for (const phone of [612345678, ['612345678'], `${'6'.repeat(26)}`]) {
      const res = await post(app, v5Body({ phone })).expect(400);
      expect(JSON.stringify(res.body)).toContain('phone');
      expect(JSON.stringify(res.body)).not.toContain('612345678');
      expect(JSON.stringify(res.body)).not.toContain('6'.repeat(26));
    }
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('criterio 7: un email ya apuntado que reenvía con otro teléfono → 202 y la fila no cambia', async () => {
    await post(app, v5Body()).expect(202);
    const stored = { ...[...prisma.rows.values()][0] };
    await post(app, v5Body({ phone: '+34 699 000 111' })).expect(202);
    expect(prisma.rows.size).toBe(1);
    expect([...prisma.rows.values()][0]).toEqual(stored);
    expect(prisma.waitlistEntry.update).not.toHaveBeenCalled();
    expect(prisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
  });
});

describe('Aviso por correo de alta nueva: sin teléfono (criterio 10)', () => {
  it('el cuerpo y el texto enviado no contienen el teléfono', async () => {
    const env: NodeJS.ProcessEnv = {
      MAIL_SMTP_HOST: 'smtp.example.test', MAIL_SMTP_PORT: '587', MAIL_SMTP_USER: 'proyecto-ficticio', MAIL_SMTP_PASSWORD: 'clave-ficticia',
      MAIL_FROM: 'AsePsico <avisos@example.test>', WAITLIST_NOTIFY_TO: 'jefe@example.test', WAITLIST_NOTIFY_ENABLED: 'true',
    };
    const send = jest.fn(async () => undefined);
    const mail = new MailService(env, () => ({ send }));
    const prisma: any = { waitlistEntry: { create: jest.fn(async () => ({ id: 'w-1' })), count: jest.fn(async () => 4) } };
    const notifier = new WaitlistNotifier(prisma, mail, env);
    await new WaitlistService(prisma, notifier).submit(v5Body() as any);
    expect(notifier.pendingCount()).toBe(1);
    await notifier.flush();
    notifier.onModuleDestroy();
    expect(send).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify((send.mock.calls as unknown[][])[0]);
    const body = waitlistNotifyBody(1, 4, new Date());
    for (const text of [sent, body]) {
      expect(text).not.toContain(PHONE_DIGITS);
      expect(text).not.toContain(PHONE_E164);
      expect(text).not.toMatch(/tel[eé]fono/i);
    }
  });
});

describe('Supresión, purga y export con teléfono (criterio 8 y CSV)', () => {
  const updateManyPrisma = () => ({ waitlistEntry: { updateMany: jest.fn(async () => ({ count: 1 })), count: jest.fn(async () => 1) } }) as any;

  it('waitlist:delete, la supresión del panel y la purga ponen phone = null', async () => {
    for (const run of [
      (p: any) => deleteWaitlistEntry(p, EMAIL),
      (p: any) => suppressWaitlistEntryById(p, 'cl0000000000000000000000'),
      (p: any) => purgeWaitlist(p, 12),
    ]) {
      const p = updateManyPrisma();
      await run(p);
      expect(p.waitlistEntry.updateMany.mock.calls[0][0].data).toMatchObject({ phone: null, name: null, email: null, emailHash: null, deletedAt: expect.any(Date) });
    }
  });

  it('CSV por defecto SIN teléfono; con WAITLIST_CSV_COLUMNS_WITH_PHONE va justo después de email, descifrado y con el + neutralizado', () => {
    expect(WAITLIST_CSV_COLUMNS).not.toContain('phone');
    expect(WAITLIST_CSV_COLUMNS_WITH_PHONE.indexOf('phone')).toBe(WAITLIST_CSV_COLUMNS_WITH_PHONE.indexOf('email') + 1);
    expect(WAITLIST_CSV_COLUMNS_WITH_PHONE.filter((c) => c !== 'phone')).toEqual([...WAITLIST_CSV_COLUMNS]);
    const row = encryptModelData('waitlistEntry', { createdAt: new Date('2026-10-27T10:00:00Z'), name: 'Persona Ficticia', email: EMAIL, phone: PHONE_E164, tools: null, privacyPolicyVersion: 'lista-espera-v5' });
    const plain = waitlistCsv([row]);
    expect(plain.csv).not.toContain(PHONE_DIGITS);
    expect(plain.csv.split('\r\n')[0]).not.toContain('phone');
    const { csv, unreadable } = waitlistCsv([row], WAITLIST_CSV_COLUMNS_WITH_PHONE);
    expect(unreadable).toBe(0);
    expect(csv.split('\r\n')[1].split(',')[3]).toBe(`'${PHONE_E164}`);
    expect(waitlistCsv([{ ...row, phone: 'enc:v1:AAAA:BBBB:CCCC' }], WAITLIST_CSV_COLUMNS_WITH_PHONE).unreadable).toBe(1);
    expect(waitlistCsv([{ ...row, phone: 'enc:v1:AAAA:BBBB:CCCC' }]).unreadable).toBe(0); // sin la columna, no cuenta
  });

  it('waitlist:export solo lee phone con --with-phone y deja PLATFORM_WAITLIST_EXPORTED {count, withPhone} en la misma transacción', async () => {
    const row = encryptModelData('waitlistEntry', { createdAt: new Date('2026-10-27T10:00:00Z'), name: 'Persona Ficticia', email: EMAIL, phone: PHONE_E164, privacyPolicyVersion: 'lista-espera-v5' });
    const make = () => {
      const tx = { waitlistEntry: { findMany: jest.fn(async () => [row]) }, platformAuditLog: { create: jest.fn(async () => ({})) } };
      return { tx, prisma: { $transaction: jest.fn(async (fn: any) => fn(tx)) } as any };
    };
    for (const withPhone of [false, true]) {
      const { tx, prisma } = make();
      let written = '';
      const res = await exportWaitlist(prisma, { withPhone, write: (csv) => { written = csv; } });
      expect(res.count).toBe(1);
      expect(Object.keys((tx.waitlistEntry.findMany.mock.calls[0] as any[])[0].select).includes('phone')).toBe(withPhone);
      expect(written.includes(PHONE_E164)).toBe(withPhone);
      const audit = (tx.platformAuditLog.create.mock.calls[0] as any[])[0].data;
      expect(audit).toEqual({ actorId: null, action: 'PLATFORM_WAITLIST_EXPORTED', entityType: 'WaitlistEntry', entityId: null, metadata: { count: 1, withPhone } });
      expect(JSON.stringify(audit)).not.toMatch(/612345678|telefono\.ficticio|Persona/);
    }
    // Si escribir el archivo falla, el error sale de la transacción (que se deshace con la auditoría).
    const { prisma } = make();
    await expect(exportWaitlist(prisma, { write: () => { throw new Error('EEXIST'); } })).rejects.toThrow('EEXIST');
  });
});

describe('CLI waitlist:set-phone: --allow-dev-secret solo con BD local (condición de Argos)', () => {
  it.each([
    ['postgresql://u:p@localhost:5432/db', true],
    ['postgresql://u:p@127.0.0.1/db', true],
    ['postgresql://u:p@[::1]:5432/db', true],
    ['postgres://u:p@db.localhost/db', true],
    ['postgresql://u:p@dpg-ficticio.frankfurt-postgres.render.com/db', false],
    ['postgresql://u:p@localhost.example.com/db', false],
    ['postgresql://u:p@127.0.0.2/db', false],
    ['postgresql://u:p@localhost/db?host=/tmp', false],
    ['mysql://u:p@localhost/db', false],
    ['no es una url', false],
    ['', false],
  ])('%j → local=%s', (url, local) => {
    expect(isLocalDatabaseUrl(url)).toBe(local);
  });

  it('con una DATABASE_URL remota y --allow-dev-secret sale con error antes de leer o conectar, sin datos en la salida', () => {
    const out = spawnSync(process.execPath, [require.resolve('tsx/cli'), join(__dirname, '..', 'prisma/scripts/waitlist-set-phone.ts'), '--allow-dev-secret'], {
      input: `${EMAIL}\n+34 612 345 678\n`, encoding: 'utf8', timeout: 90_000,
      // Host .invalid (RFC 2606): si el CLI intentara conectar, fallaría con otro mensaje.
      env: { ...process.env, DATABASE_URL: 'postgresql://ficticio:ficticio@bd-remota.invalid:5432/asepsico', WAITLIST_SECRET: '', FIELD_ENCRYPTION_KEY: '' },
    });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain('--allow-dev-secret solo se admite con una DATABASE_URL local');
    expect(`${out.stdout}${out.stderr}`).not.toMatch(/612.?345.?678|telefono\.ficticio/);
  });

  it('el mensaje de email de set-phone habla de stdin y del aviso oculto, no de --email', () => {
    const cli = readFileSync(join(__dirname, '..', 'prisma/scripts/waitlist-set-phone.ts'), 'utf8');
    expect(cli).toContain('assertEmailLookupConfig(args, email, EMAIL_STDIN_HINT)');
    expect(cli).toMatch(/EMAIL_STDIN_HINT = '[^']*entrada estándar[^']*'/);
    expect(cli).not.toContain('Indica el email con --email');
  });
});

describe('Panel /admin/waitlist: teléfono descifrado y contador withoutPhone (criterio 11)', () => {
  const row = (overrides: Partial<WaitlistRow>): WaitlistRow => ({
    id: 'cl0000000000000000000001', createdAt: new Date('2026-10-27T10:00:00Z'), name: null, email: null, phone: null,
    situation: 'SELF_EMPLOYED', professionalsCount: null, tools: null, source: null, privacyPolicyVersion: 'lista-espera-v5',
    commercialConsentRequested: false, commercialConsentRequestedAt: null, commercialConsent: false, commercialConsentAt: null,
    commercialConsentWithdrawnAt: null, ...overrides,
  });

  it('se selecciona phone (nunca emailHash) y se descifra; null y no legible se distinguen', () => {
    expect(PLATFORM_WAITLIST_SELECT).toMatchObject({ phone: true });
    expect(PLATFORM_WAITLIST_SELECT).not.toHaveProperty('emailHash');
    const withPhone = row({ ...(encryptModelData('waitlistEntry', { name: 'Persona Ficticia', email: EMAIL, phone: PHONE_E164 }) as any) });
    const withoutPhone = row({ id: 'cl0000000000000000000002', privacyPolicyVersion: 'lista-espera-v4' });
    const unreadable = row({ id: 'cl0000000000000000000003', phone: 'enc:v1:AAAA:BBBB:CCCC' });
    const res = buildWaitlistResponse([withPhone, withoutPhone, unreadable], new Date('2026-10-28T10:00:00Z'));
    expect(res.entries.map((e) => [e.phone, e.unreadableFields])).toEqual([[PHONE_E164, []], [null, []], [null, ['phone']]]);
    expect(res.counters.withoutPhone).toBe(1);
    expect(res.counters.totalActive).toBe(3);
    expect(res.unreadable).toBe(1);
    expect(JSON.stringify(res)).not.toMatch(ENC);
  });
});

describe('Nada del teléfono en logs ni en auditoría (revisión estática)', () => {
  const src = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

  it('ningún logger ni console de la lista de espera interpola phone', () => {
    for (const file of ['src/waitlist/waitlist.service.ts', 'src/waitlist/waitlist-admin.ts', 'src/waitlist/waitlist-phone.ts', 'src/platform/platform-waitlist.service.ts', 'prisma/scripts/waitlist-set-phone.ts']) {
      const calls = src(file).match(/(logger\.\w+|console\.\w+)\([^;]*\);/g) ?? [];
      for (const call of calls) expect(call).not.toMatch(/phone|rawPhone|email\b/i);
    }
  });

  it('la metadata de PlatformAuditLog para el teléfono es una lista cerrada sin valores', () => {
    const audit = src('src/platform/platform-audit.ts');
    expect(audit).toContain("{ action: 'PLATFORM_WAITLIST_PHONE_SET'; metadata: { source: 'cli' } }");
    expect(audit).toContain("{ action: 'PLATFORM_WAITLIST_PHONE_CLEARED'; metadata: { source: 'cli' | 'panel' } }");
  });

  it('el CLI no admite el email ni el teléfono como argumentos', () => {
    const cli = src('prisma/scripts/waitlist-set-phone.ts');
    expect(cli).toContain("const KNOWN = new Set(['--clear', '--allow-dev-secret']);");
    expect(cli).not.toMatch(/emailArg|--phone/);
  });
});
