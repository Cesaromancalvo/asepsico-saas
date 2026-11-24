import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { purgeStaleRegistrationInvites } from '../src/auth/registration-invite-purge';

/**
 * invites:purge contra PostgreSQL REAL: borra solo las invitaciones sin usar caducadas o revocadas;
 * nunca una usada ni una vigente. Como los demás *-db: solo con RACE_DATABASE_URL (BD DESECHABLE ya
 * migrada); con RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Datos 100 % ficticios.
 *
 * La BD puede tener otras invitaciones (otros tests): se comprueba por las filas creadas aquí y se usa
 * un "now" muy en el futuro solo para contar, nunca para borrar las ajenas vigentes.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de invites:purge no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(60_000);

describeDb('invites:purge (PostgreSQL real)', () => {
  let prisma: PrismaClient;
  const run = `invpurge-${Date.now()}`;
  const DAY = 24 * 60 * 60 * 1000;
  beforeAll(() => { prisma = new PrismaClient({ datasourceUrl: url }); });
  afterAll(async () => { await prisma?.$disconnect(); });

  const invite = (label: string, data: Record<string, unknown>) => prisma.registrationInvite.create({
    data: { tokenHash: randomBytes(32).toString('hex'), email: `${label}-${run}@example.test`, createdBy: 'test', expiresAt: new Date(Date.now() + 14 * DAY), ...data },
  });

  it('borra solo sin usar + (caducada o revocada); la usada y la vigente se quedan', async () => {
    const ws = await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}` } });
    const user = await prisma.user.create({ data: { email: `titular-${run}@example.test`, passwordHash: 'hash-ficticio', firstName: 'Titular', lastName: 'Ficticio' } });
    const expired = await invite('caducada', { expiresAt: new Date(Date.now() - DAY) });
    const revoked = await invite('revocada', { revokedAt: new Date() });
    const live = await invite('vigente', {});
    const usedExpired = await invite('usada', { expiresAt: new Date(Date.now() - DAY), usedAt: new Date(), usedByUserId: user.id, workspaceId: ws.id });

    const dry = await purgeStaleRegistrationInvites(prisma);
    expect(dry.deleted).toBe(false);
    expect(dry.total).toBeGreaterThanOrEqual(2);
    expect(await prisma.registrationInvite.count({ where: { id: { in: [expired.id, revoked.id] } } })).toBe(2);

    const applied = await purgeStaleRegistrationInvites(prisma, { apply: true });
    expect(applied.deleted).toBe(true);
    expect(applied.total).toBe(dry.total);
    const left = await prisma.registrationInvite.findMany({ where: { id: { in: [expired.id, revoked.id, live.id, usedExpired.id] } }, select: { id: true } });
    expect(left.map((r) => r.id).sort()).toEqual([live.id, usedExpired.id].sort());
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);

    await prisma.registrationInvite.deleteMany({ where: { id: { in: [live.id, usedExpired.id] } } });
  });
});
