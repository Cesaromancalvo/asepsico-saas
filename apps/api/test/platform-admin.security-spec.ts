import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encryptModelData } from '../src/common/crypto/clinical-crypto';
import { isPlatformAdmin, parsePlatformAdminEmails } from '../src/platform/platform-admin.config';
import { buildWaitlistResponse, commercialStatus, isoWeekOfDay, lastMadridWeeks, madridIsoWeek, WaitlistRow } from '../src/platform/platform-waitlist.view';

/**
 * Panel privado de la lista de espera (PLATFORM_ADMIN): lógica pura y comprobaciones estáticas.
 * Las pruebas HTTP contra PostgreSQL real están en platform-admin-db.security-spec.ts.
 * Datos 100 % ficticios.
 */

const ADMIN_EMAIL = 'admin.ficticio@example.com';

function fakeUsers(account: { email: string; totpEnabled: boolean } | null) {
  return { user: { findUnique: jest.fn(async () => account) } } as any;
}

describe('PLATFORM_ADMIN: asignación solo por PLATFORM_ADMIN_EMAILS (falla cerrado)', () => {
  it('sin variable, vacía o solo con comas/espacios/basura: nadie', () => {
    expect(parsePlatformAdminEmails(undefined).size).toBe(0);
    expect(parsePlatformAdminEmails('').size).toBe(0);
    expect(parsePlatformAdminEmails(' , ,, ').size).toBe(0);
    expect(parsePlatformAdminEmails('*,true,admin').size).toBe(0);
  });

  it('normaliza mayúsculas y espacios', () => {
    expect([...parsePlatformAdminEmails('  Admin.Ficticio@EXAMPLE.com , ')]).toEqual([ADMIN_EMAIL]);
  });

  it('variable vacía: false sin consultar siquiera la BD', async () => {
    const db = fakeUsers({ email: ADMIN_EMAIL, totpEnabled: true });
    expect(await isPlatformAdmin(db, { sub: 'u1', mfaEnabled: true }, {})).toBe(false);
    expect(await isPlatformAdmin(db, { sub: 'u1', mfaEnabled: true }, { PLATFORM_ADMIN_EMAILS: '' })).toBe(false);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('exige MFA en la sesión (token) Y en la cuenta (BD) y el email de la BD en la lista', async () => {
    const env = { PLATFORM_ADMIN_EMAILS: ADMIN_EMAIL };
    expect(await isPlatformAdmin(fakeUsers({ email: ADMIN_EMAIL, totpEnabled: true }), { sub: 'u1', mfaEnabled: true }, env)).toBe(true);
    expect(await isPlatformAdmin(fakeUsers({ email: ADMIN_EMAIL, totpEnabled: true }), { sub: 'u1', mfaEnabled: false }, env)).toBe(false);
    expect(await isPlatformAdmin(fakeUsers({ email: ADMIN_EMAIL, totpEnabled: true }), { sub: 'u1' }, env)).toBe(false);
    expect(await isPlatformAdmin(fakeUsers({ email: ADMIN_EMAIL, totpEnabled: false }), { sub: 'u1', mfaEnabled: true }, env)).toBe(false);
    expect(await isPlatformAdmin(fakeUsers({ email: 'otra.persona@example.com', totpEnabled: true }), { sub: 'u1', mfaEnabled: true }, env)).toBe(false);
    expect(await isPlatformAdmin(fakeUsers(null), { sub: 'u1', mfaEnabled: true }, env)).toBe(false);
    expect(await isPlatformAdmin(fakeUsers({ email: ADMIN_EMAIL, totpEnabled: true }), null, env)).toBe(false);
  });

  it('el email del TOKEN no cuenta: se usa el de la BD', async () => {
    const db = fakeUsers({ email: 'otra.persona@example.com', totpEnabled: true });
    expect(await isPlatformAdmin(db, { sub: 'u1', mfaEnabled: true, email: ADMIN_EMAIL } as any, { PLATFORM_ADMIN_EMAILS: ADMIN_EMAIL })).toBe(false);
  });
});

describe('PLATFORM_ADMIN: sin equivalencias Unicode (veto ALTA de Argos)', () => {
  const env = { PLATFORM_ADMIN_EMAILS: 'admin@x.test,fiona@x.test' };
  const lookalikes = [
    '\uFF41dmin@x.test', // «ａ» de ancho completo
    '\uFF41\uFF44\uFF4D\uFF49\uFF4E\uFF20\uFF58\uFF0E\uFF54\uFF45\uFF53\uFF54', // todo en ancho completo
    '\uFB01ona@x.test', // ligadura «ﬁ»
    'admin@x.test\u200B', // espacio de anchura cero
    'admin@x\uFF0Etest', // punto de ancho completo
  ];

  it.each(lookalikes)('una cuenta con MFA y email %j NO es PLATFORM_ADMIN', async (email) => {
    expect(email.normalize('NFKC').toLowerCase().replace('\u200B', '')).toMatch(/^(admin|fiona)@x\.test$/); // con NFKC sí habría coincidido
    expect(await isPlatformAdmin(fakeUsers({ email, totpEnabled: true }), { sub: 'u1', mfaEnabled: true }, env)).toBe(false);
  });

  it('se compara por igualdad exacta con el email guardado (trim + minúsculas, como el registro)', async () => {
    expect(await isPlatformAdmin(fakeUsers({ email: 'admin@x.test', totpEnabled: true }), { sub: 'u1', mfaEnabled: true }, env)).toBe(true);
    expect(await isPlatformAdmin(fakeUsers({ email: 'fiona@x.test', totpEnabled: true }), { sub: 'u1', mfaEnabled: true }, env)).toBe(true);
    // Un email guardado con mayúsculas (no debería existir) no se "arregla": falla cerrado.
    expect(await isPlatformAdmin(fakeUsers({ email: 'Admin@x.test', totpEnabled: true }), { sub: 'u1', mfaEnabled: true }, env)).toBe(false);
  });

  it('las entradas no ASCII de la variable se ignoran', () => {
    expect([...parsePlatformAdminEmails(`${lookalikes.join(',')}, ADMIN@X.TEST `)]).toEqual(['admin@x.test']);
  });
});

describe('PLATFORM_ADMIN: nada en el código ni en el esquema puede concederlo', () => {
  const src = resolve(__dirname, '../src');
  const files: string[] = [];
  const walk = (dir: string) => readdirSync(dir).forEach((f) => { const p = join(dir, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p); });
  walk(src);

  it('PLATFORM_ADMIN_EMAILS solo se lee en platform-admin.config.ts', () => {
    const readers = files.filter((f) => readFileSync(f, 'utf8').includes('PLATFORM_ADMIN_EMAILS')).map((f) => f.slice(src.length + 1));
    expect(readers).toEqual([join('platform', 'platform-admin.config.ts')]);
    expect(readFileSync(join(src, 'platform', 'platform-admin.config.ts'), 'utf8')).not.toMatch(/process\.env\.PLATFORM_ADMIN_EMAILS\s*=/);
  });

  it('ni el esquema ni los seeds guardan la capacidad (no es un WorkspaceRole)', () => {
    const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8');
    const roleEnum = schema.match(/enum WorkspaceRole \{[^}]*\}/)![0];
    expect(roleEnum).not.toMatch(/PLATFORM/);
    expect(schema).not.toMatch(/platformAdmin\s+Boolean/i);
    const prismaDir = resolve(__dirname, '../prisma');
    const seeds: string[] = [];
    const walkTs = (dir: string) => readdirSync(dir).forEach((f) => { const p = join(dir, f); statSync(p).isDirectory() ? walkTs(p) : /\.(ts|js)$/.test(p) && seeds.push(p); });
    walkTs(prismaDir);
    expect(seeds.length).toBeGreaterThan(5);
    for (const seed of seeds) expect(readFileSync(seed, 'utf8')).not.toMatch(/PLATFORM_ADMIN/);
  });

  it('los endpoints de plataforma no tocan tablas con workspaceId ni AuditLog de tenant', () => {
    const platform = files.filter((f) => f.includes(`${join('src', 'platform')}`)).map((f) => readFileSync(f, 'utf8')).join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '') // sin comentarios
      // Única excepción: el actor de MfaService.runAttempt (contador de fallos por cuenta). Sus fallos
      // se auditan en el workspace PROPIO del admin (el interno vacío), nunca en el de un cliente.
      .replace('{ userId: user.sub, workspaceId: user.workspaceId }', '{ ACTOR_DEL_TOKEN }');
    expect(platform).not.toMatch(/\.(auditLog|patient|clinicalProcess|session|workspaceMember|workspace)\./);
    expect(platform).not.toMatch(/workspaceId/);
  });
});

describe('Contadores semanales en hora de Madrid', () => {
  it('semana ISO correcta, incluido el cambio de año (2026 tiene 53 semanas)', () => {
    expect(isoWeekOfDay(new Date(Date.UTC(2026, 9, 22)))).toMatchObject({ isoWeek: '2026-W43', weekStart: '2026-10-19' });
    expect(isoWeekOfDay(new Date(Date.UTC(2026, 11, 31))).isoWeek).toBe('2026-W53');
    expect(isoWeekOfDay(new Date(Date.UTC(2027, 0, 3))).isoWeek).toBe('2026-W53');
    expect(isoWeekOfDay(new Date(Date.UTC(2027, 0, 4))).isoWeek).toBe('2027-W01');
  });

  it('domingo 23:30 de Madrid cae en su semana aunque en UTC aún sea domingo; lunes 00:30 de Madrid, en la siguiente', () => {
    // Horario de verano (UTC+2): domingo 18/10/2026 23:30 Madrid = 21:30 UTC.
    expect(madridIsoWeek(new Date('2026-10-18T21:30:00Z')).isoWeek).toBe('2026-W42');
    // Lunes 19/10/2026 00:30 Madrid = domingo 22:30 UTC: en UTC sería W42, en Madrid es W43.
    expect(madridIsoWeek(new Date('2026-10-18T22:30:00Z')).isoWeek).toBe('2026-W43');
    // Horario de invierno (UTC+1): domingo 01/11/2026 23:30 Madrid = 22:30 UTC.
    expect(madridIsoWeek(new Date('2026-11-01T22:30:00Z')).isoWeek).toBe('2026-W44');
    expect(madridIsoWeek(new Date('2026-11-01T23:30:00Z')).isoWeek).toBe('2026-W45');
  });

  it('últimas 8 semanas, de la más antigua a la actual', () => {
    const weeks = lastMadridWeeks(new Date('2026-10-22T10:00:00Z'));
    expect(weeks).toHaveLength(8);
    expect(weeks[7]).toEqual({ isoWeek: '2026-W43', weekStart: '2026-10-19' });
    expect(weeks[0]).toEqual({ isoWeek: '2026-W36', weekStart: '2026-08-31' });
  });
});

describe('Filas del panel', () => {
  const base = (overrides: Partial<WaitlistRow> = {}): WaitlistRow => ({
    id: 'clfakeentry0000000000001',
    createdAt: new Date('2026-10-18T21:30:00Z'),
    ...(encryptModelData('waitlistEntry', { name: 'Profesional Ficticia Uno', email: 'ficticia.uno@example.com', tools: 'Papel / agenda' }) as any),
    situation: 'SELF_EMPLOYED',
    professionalsCount: 1,
    source: 'PROFESSIONAL_COLLEGE',
    privacyPolicyVersion: 'lista-espera-v3',
    commercialConsentRequested: false,
    commercialConsentRequestedAt: null,
    commercialConsent: false,
    commercialConsentAt: null,
    commercialConsentWithdrawnAt: null,
    ...overrides,
  });

  it('estado comercial: v3 "—", v2 solicitado sin confirmar, válido y retirado', () => {
    const at = new Date('2026-10-16T08:00:00Z');
    expect(commercialStatus(base())).toEqual({ status: 'NONE', at: null });
    expect(commercialStatus(base({ privacyPolicyVersion: 'lista-espera-v2', commercialConsentRequested: true, commercialConsentRequestedAt: at }))).toEqual({ status: 'REQUESTED_UNCONFIRMED', at: at.toISOString() });
    expect(commercialStatus(base({ commercialConsentRequested: true, commercialConsent: true, commercialConsentAt: at }))).toEqual({ status: 'VALID', at: at.toISOString() });
    expect(commercialStatus(base({ commercialConsentWithdrawnAt: at }))).toEqual({ status: 'WITHDRAWN', at: at.toISOString() });
  });

  it('descifra, marca "no legible" sin romper y cuenta por origen, situación y semana', () => {
    const now = new Date('2026-10-22T10:00:00Z');
    const response = buildWaitlistResponse([
      base(),
      base({ id: 'clfakeentry0000000000002', tools: 'enc:v1:AAAA:BBBB:CCCC', source: null, situation: null, createdAt: new Date('2026-10-18T22:30:00Z') }),
    ], now);
    expect(response.entries[0]).toMatchObject({ name: 'Profesional Ficticia Uno', email: 'ficticia.uno@example.com', tools: 'Papel / agenda', isoWeek: '2026-W42', unreadableFields: [] });
    expect(response.entries[1]).toMatchObject({ tools: null, unreadableFields: ['tools'], isoWeek: '2026-W43' });
    expect(response.unreadable).toBe(1);
    expect(response.counters.totalActive).toBe(2);
    expect(response.counters.bySource).toMatchObject({ PROFESSIONAL_COLLEGE: 1, UNSPECIFIED: 1, INSTAGRAM: 0, NOT_SAID: 0 });
    expect(response.counters.bySituation).toMatchObject({ SELF_EMPLOYED: 1, UNSPECIFIED: 1, PRACTICE: 0 });
    expect(response.counters.weekly.slice(-2).map((w) => w.count)).toEqual([1, 1]);
    expect(JSON.stringify(response)).not.toMatch(/enc:v[12]:/);
  });
});
