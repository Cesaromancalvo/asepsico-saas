import { INestApplication, LoggerService, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import * as cookieParser from 'cookie-parser';
import { generate } from 'otplib';
import request = require('supertest');
import { getJwtSecret } from '../src/auth/jwt-secret.util';
import { hashToken } from '../src/auth/token.util';
import { encryptField } from '../src/common/crypto/field-encryption';
import { getCurrentLegalDocuments } from '../src/legal/legal-documents';

/**
 * Transición de cookies de la salida de Vercel (sesión 7), con la app COMPLETA y PostgreSQL REAL.
 *
 * Simula el navegador de un profesional que YA tiene en producción access_token y refresh_token
 * con Domain=.asepsico.es (antes del cambio) y una API con COOKIE_DOMAIN=.asepsico.es. El jar de
 * cookies sigue RFC 6265 en lo que importa aquí: identidad por (nombre, dominio, ruta), host-only
 * frente a Domain, borrado por Expires pasado o Max-Age<=0, conservación de la hora de creación al
 * reemplazar y orden del header Cookie (ruta más larga primero; a igual ruta, la más antigua
 * primero, que es la que cookie-parser se queda). La web (app.asepsico.es) lee csrf_token como
 * document.cookie y lo reenvía en x-csrf-token, igual que apps/web/lib/api.ts y el portal.
 *
 * Como los demás *-db/*-race: solo con RACE_DATABASE_URL (BD DESECHABLE ya migrada); con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Datos 100 % ficticios.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de transición de cookies no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

const API_HOST = 'api.asepsico.es';
const WEB_HOST = 'app.asepsico.es';
const DOMAIN = '.asepsico.es';

type Cookie = { name: string; value: string; domain: string; hostOnly: boolean; path: string; httpOnly: boolean; expiresAt: number | null; created: number };

/** Jar mínimo de navegador (RFC 6265 §5.3/§5.4) con reloj propio para simular esperas. */
class BrowserJar {
  private cookies: Cookie[] = [];
  private seq = 0;
  now = Date.now();

  private purge() { this.cookies = this.cookies.filter((c) => c.expiresAt === null || c.expiresAt > this.now); }
  advance(ms: number) { this.now += ms; this.purge(); }

  /** Cookie preexistente (estado de producción antes del cambio). */
  preload(c: Omit<Cookie, 'created'>) { this.cookies.push({ ...c, created: this.seq++ }); }

  store(setCookies: string[] | string | undefined, host = API_HOST) {
    for (const raw of ([] as string[]).concat(setCookies ?? [])) {
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      let domain: string | null = null;
      let path = '/';
      let expiresAt: number | null = null;
      let httpOnly = false;
      for (const attr of attrs) {
        const [k, ...rest] = attr.split('=');
        const v = rest.join('=');
        const key = k.toLowerCase();
        if (key === 'domain') domain = v.replace(/^\./, '').toLowerCase();
        else if (key === 'path') path = v || '/';
        else if (key === 'httponly') httpOnly = true;
        else if (key === 'max-age') expiresAt = this.now + Number(v) * 1000;
        else if (key === 'expires' && expiresAt === null) expiresAt = Date.parse(v);
      }
      if (domain && !(host === domain || host.endsWith(`.${domain}`))) continue; // dominio ajeno: se ignora
      const hostOnly = !domain;
      const cookieDomain = domain ?? host;
      const idx = this.cookies.findIndex((c) => c.name === name && c.domain === cookieDomain && c.path === path);
      const created = idx >= 0 ? this.cookies[idx].created : this.seq++;
      if (idx >= 0) this.cookies.splice(idx, 1);
      if (expiresAt !== null && expiresAt <= this.now) continue; // borrado
      this.cookies.push({ name, value, domain: cookieDomain, hostOnly, path, httpOnly, expiresAt, created });
    }
  }

  private matching(host: string, path: string) {
    this.purge();
    return this.cookies
      .filter((c) => (c.hostOnly ? c.domain === host : host === c.domain || host.endsWith(`.${c.domain}`)))
      .filter((c) => path === c.path || (path.startsWith(c.path) && (c.path.endsWith('/') || path[c.path.length] === '/')))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  }

  header(path: string, host = API_HOST) { return this.matching(host, path).map((c) => `${c.name}=${c.value}`).join('; '); }
  /** Lo que ve document.cookie en la web (app.asepsico.es): sin httpOnly. */
  documentCookie(host = WEB_HOST) { return this.matching(host, '/').filter((c) => !c.httpOnly).map((c) => `${c.name}=${c.value}`).join('; '); }
  csrfFromWeb() { return decodeURIComponent(this.documentCookie().split('; ').find((x) => x.startsWith('csrf_token='))?.split('=')[1] ?? ''); }
  find(name: string) { this.purge(); return this.cookies.filter((c) => c.name === name); }
}

class SilentLogger implements LoggerService { log() {} error() {} warn() {} debug() {} verbose() {} fatal() {} }

describeDb('Transición de cookies de sesión (Domain=.asepsico.es → host-only), PostgreSQL real', () => {
  const run = `cookies-${Date.now()}`;
  const PASSWORD = 'ClaveFicticiaCookies-123';
  const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // ficticio, 20 bytes
  const STAFF_EMAIL = `${run}-owner@example.com`;
  const PORTAL_EMAIL = `${run}-paciente@example.com`;
  const PORTAL_PASSWORD = 'ClavePortalFicticia-123';
  const previousEnv = { DATABASE_URL: process.env.DATABASE_URL, COOKIE_DOMAIN: process.env.COOKIE_DOMAIN };
  const ids: Record<string, string> = {};
  let prisma: PrismaClient;
  let app: INestApplication;

  const send = async (jar: BrowserJar, method: 'get' | 'post' | 'patch', path: string, body?: object, csrf = false) => {
    let r = request(app.getHttpServer())[method](path).set('Host', API_HOST).set('Origin', `https://${WEB_HOST}`);
    const cookie = jar.header(path);
    if (cookie) r = r.set('Cookie', cookie);
    if (csrf) r = r.set('x-csrf-token', jar.csrfFromWeb());
    const res = body === undefined ? await r : await r.send(body);
    jar.store(res.headers['set-cookie']);
    return res;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.COOKIE_DOMAIN = DOMAIN;
    prisma = new PrismaClient({ datasourceUrl: url });
    const passwordHash = await hash(PASSWORD, 4);
    ids.ws = (await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}` } })).id;
    const user = await prisma.user.create({ data: { email: STAFF_EMAIL, passwordHash, firstName: 'Usuaria', lastName: 'Ficticia', totpEnabled: true, totpSecret: encryptField(TOTP_SECRET)! } });
    ids.user = user.id;
    await prisma.workspaceMember.create({ data: { workspaceId: ids.ws, userId: user.id, role: 'OWNER', isClinician: true } });
    for (const doc of getCurrentLegalDocuments()) await prisma.termsAcceptance.create({ data: { workspaceId: ids.ws, userId: user.id, documentType: doc.type, version: doc.version, textHash: doc.textHash } });

    // Paciente ficticio con portal activo y conversación abierta.
    ids.patient = (await prisma.patient.create({ data: { workspaceId: ids.ws, firstName: 'PacienteFicticio', lastName: run } })).id;
    await (prisma as any).patientPortalAccount.create({ data: { workspaceId: ids.ws, patientId: ids.patient, email: PORTAL_EMAIL, passwordHash: await hash(PORTAL_PASSWORD, 4), mustChangePassword: false } });
    await prisma.conversation.create({ data: { workspaceId: ids.ws, patientId: ids.patient } });

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: new SilentLogger() });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (prisma && ids.ws) {
      await prisma.message.deleteMany({ where: { conversation: { workspaceId: ids.ws } } });
      await prisma.conversation.deleteMany({ where: { workspaceId: ids.ws } });
      await (prisma as any).patientPortalAccount.deleteMany({ where: { workspaceId: ids.ws } });
      await prisma.notification.deleteMany({ where: { workspaceId: ids.ws } });
      await prisma.auditLog.deleteMany({ where: { workspaceId: ids.ws } });
      await prisma.patient.deleteMany({ where: { workspaceId: ids.ws } });
      await prisma.refreshToken.deleteMany({ where: { userId: ids.user } });
      await prisma.termsAcceptance.deleteMany({ where: { userId: ids.user } });
      await prisma.workspaceMember.deleteMany({ where: { workspaceId: ids.ws } });
      await prisma.user.deleteMany({ where: { id: ids.user } }).catch(() => undefined);
      await prisma.workspace.deleteMany({ where: { id: ids.ws } }).catch(() => undefined);
    }
    await prisma?.$disconnect();
    for (const [k, v] of Object.entries(previousEnv)) if (v === undefined) delete (process.env as any)[k]; else process.env[k] = v;
  });

  it('navegador con cookies antiguas Domain=.asepsico.es: login MFA, 2 refresh tras 16 min, mutación CSRF y logout sin 401 ni reutilización', async () => {
    // Estado de producción hoy: una sesión anterior con Domain=.asepsico.es. Su refresh token ya se
    // rotó (revocado): si llegara a la API dispararía la detección de reutilización. En la misma
    // familia queda un token vivo que actúa de testigo: si la familia se revoca, se ha detectado.
    const legacyRaw = `legacy-ficticio-${run}`;
    await prisma.refreshToken.create({ data: { userId: ids.user, workspaceId: ids.ws, tokenHash: hashToken(legacyRaw), family: `legacy-${run}`, expiresAt: new Date(Date.now() + 86_400_000), revokedAt: new Date(), replacedBy: hashToken(`${legacyRaw}-sucesor`) } });
    const witness = await prisma.refreshToken.create({ data: { userId: ids.user, workspaceId: ids.ws, tokenHash: hashToken(`${legacyRaw}-sucesor`), family: `legacy-${run}`, expiresAt: new Date(Date.now() + 86_400_000) } });
    const expiredAccess = new JwtService({ secret: getJwtSecret() }).sign({ sub: ids.user, email: STAFF_EMAIL, workspaceId: ids.ws, role: 'OWNER', mfaEnabled: true, tv: 0, sid: `legacy-${run}`, exp: Math.floor(Date.now() / 1000) - 3600 });

    const jar = new BrowserJar();
    const old = { domain: 'asepsico.es', hostOnly: false, httpOnly: true, expiresAt: jar.now + 6 * 86_400_000 };
    jar.preload({ ...old, name: 'access_token', value: expiredAccess, path: '/' });
    jar.preload({ ...old, name: 'refresh_token', value: legacyRaw, path: '/api/v1/auth' });
    jar.preload({ ...old, name: 'csrf_token', value: 'csrf-antiguo-ficticio', path: '/', httpOnly: false });

    const login = await send(jar, 'post', '/api/v1/auth/login', { email: STAFF_EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    const mfa = await send(jar, 'post', '/api/v1/auth/login/mfa', { pendingToken: login.body.pendingToken, code: await generate({ secret: TOTP_SECRET }) });
    expect(mfa.status).toBe(200);

    // Las antiguas con Domain han desaparecido; las nuevas son host-only en api.; csrf con Domain.
    for (const name of ['access_token', 'refresh_token']) {
      expect(jar.find(name).map((c) => [c.domain, c.hostOnly])).toEqual([[API_HOST, true]]);
    }
    expect(jar.find('csrf_token').map((c) => [c.domain, c.hostOnly])).toEqual([['asepsico.es', false]]);
    expect(jar.header('/api/v1/auth/refresh')).not.toContain(legacyRaw);
    expect((await send(jar, 'get', '/api/v1/auth/me')).status).toBe(200);

    // Más de 15 min sin actividad: caducan access_token y csrf_token en el navegador.
    jar.advance(16 * 60_000);
    expect(jar.find('access_token')).toHaveLength(0);
    const r1 = await send(jar, 'post', '/api/v1/auth/refresh');
    const r2 = await send(jar, 'post', '/api/v1/auth/refresh');
    expect([r1.status, r2.status]).toEqual([200, 200]);

    const pref = await send(jar, 'patch', '/api/v1/notifications/preferences', { taskReminders: true }, true);
    expect(pref.status).toBe(200);

    const logout = await send(jar, 'post', '/api/v1/auth/logout');
    expect(logout.status).toBe(200);
    expect(jar.find('access_token')).toHaveLength(0);
    expect(jar.find('refresh_token')).toHaveLength(0);
    expect(jar.find('csrf_token')).toHaveLength(0);

    // Sin detección de reutilización: la familia antigua sigue como estaba (testigo vivo) y la
    // nueva solo tiene revocaciones por rotación (con sucesor) y la del logout.
    expect((await prisma.refreshToken.findUnique({ where: { id: witness.id } }))?.revokedAt).toBeNull();
    const fresh = await prisma.refreshToken.findMany({ where: { userId: ids.user, NOT: { family: `legacy-${run}` } }, orderBy: { createdAt: 'asc' } });
    expect(fresh).toHaveLength(3);
    expect(new Set(fresh.map((t) => t.family)).size).toBe(1);
    expect(fresh.slice(0, 2).every((t) => t.revokedAt && t.replacedBy)).toBe(true);
    expect(fresh[2].revokedAt).not.toBeNull();
    expect(fresh[2].replacedBy).toBeNull();
  });

  it('portal: login con csrf_token antiguo (host-only en api. y con Domain) y mensaje con CSRF sin 403', async () => {
    const jar = new BrowserJar();
    // csrf_token host-only en api. (de antes de COOKIE_DOMAIN) y otro antiguo con Domain.
    jar.preload({ name: 'csrf_token', value: 'csrf-host-only-antiguo', domain: API_HOST, hostOnly: true, path: '/', httpOnly: false, expiresAt: jar.now + 600_000 });
    jar.preload({ name: 'csrf_token', value: 'csrf-domain-antiguo', domain: 'asepsico.es', hostOnly: false, path: '/', httpOnly: false, expiresAt: jar.now + 600_000 });

    const login = await send(jar, 'post', '/api/v1/portal/auth/login', { email: PORTAL_EMAIL, password: PORTAL_PASSWORD });
    expect(login.status).toBe(201);
    expect(jar.find('csrf_token').map((c) => [c.domain, c.hostOnly])).toEqual([['asepsico.es', false]]);
    expect(jar.csrfFromWeb()).not.toMatch(/antiguo/);

    const msg = await send(jar, 'post', '/api/v1/portal/messages', { body: 'Mensaje ficticio de prueba' }, true);
    expect(msg.status).toBe(201);
    // Control: sin la cabecera CSRF la misma mutación sí da 403.
    const noCsrf = await send(jar, 'post', '/api/v1/portal/messages', { body: 'Mensaje ficticio sin csrf' });
    expect(noCsrf.status).toBe(403);
  });
});
