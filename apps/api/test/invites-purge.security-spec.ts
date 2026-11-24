import { readFileSync } from 'fs';
import { join } from 'path';
import { InvitePurgeMismatch, purgeStaleRegistrationInvites, staleRegistrationInviteWhere } from '../src/auth/registration-invite-purge';

/**
 * invites:purge (Argos 23/11/2026, punto 3): solo invitaciones SIN USAR caducadas o revocadas, en una
 * transacción, simulación por defecto y solo recuentos. Datos 100 % ficticios. La prueba contra
 * PostgreSQL real está en invites-purge-db.security-spec.ts.
 */
const NOW = new Date('2026-12-07T09:00:00Z');

function fakeDb(counts: { total: number; expired: number }, deletedCount = counts.total) {
  const calls: { op: string; args: any }[] = [];
  const tx = {
    registrationInvite: {
      count: jest.fn(async (args: any) => { calls.push({ op: 'count', args }); return args.where.OR ? counts.total : counts.expired; }),
      deleteMany: jest.fn(async (args: any) => { calls.push({ op: 'deleteMany', args }); return { count: deletedCount }; }),
    },
  };
  const db = { $transaction: jest.fn(async (fn: any) => fn(tx)) } as any;
  return { db, tx, calls };
}

describe('invites:purge · qué se borra', () => {
  it('el filtro exige SIEMPRE usedAt IS NULL (y sin usuario ni espacio) y caducada o revocada', () => {
    expect(staleRegistrationInviteWhere(NOW)).toEqual({
      usedAt: null, usedByUserId: null, workspaceId: null,
      OR: [{ expiresAt: { lt: NOW } }, { revokedAt: { not: null } }],
    });
  });

  it('simulación por defecto: cuenta en una transacción y no borra', async () => {
    const { db, tx } = fakeDb({ total: 3, expired: 2 });
    expect(await purgeStaleRegistrationInvites(db, { now: NOW })).toEqual({ expired: 2, revoked: 1, total: 3, deleted: false });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.registrationInvite.deleteMany).not.toHaveBeenCalled();
  });

  it('con apply borra con el MISMO filtro que el recuento', async () => {
    const { db, tx } = fakeDb({ total: 3, expired: 2 });
    expect(await purgeStaleRegistrationInvites(db, { apply: true, now: NOW })).toEqual({ expired: 2, revoked: 1, total: 3, deleted: true });
    expect(tx.registrationInvite.deleteMany).toHaveBeenCalledWith({ where: staleRegistrationInviteWhere(NOW) });
    expect(tx.registrationInvite.count.mock.calls[1][0].where).toMatchObject({ usedAt: null, usedByUserId: null, workspaceId: null });
  });

  it('si el DELETE no coincide con el recuento, lanza (la transacción se deshace)', async () => {
    const { db } = fakeDb({ total: 3, expired: 2 }, 4);
    await expect(purgeStaleRegistrationInvites(db, { apply: true, now: NOW })).rejects.toBeInstanceOf(InvitePurgeMismatch);
  });

  it('sin nada que borrar no llama a deleteMany', async () => {
    const { db, tx } = fakeDb({ total: 0, expired: 0 });
    expect((await purgeStaleRegistrationInvites(db, { apply: true, now: NOW })).deleted).toBe(false);
    expect(tx.registrationInvite.deleteMany).not.toHaveBeenCalled();
  });

  it('el resultado solo lleva recuentos (nada de correos ni ids)', async () => {
    const { db } = fakeDb({ total: 1, expired: 1 });
    const result = await purgeStaleRegistrationInvites(db, { apply: true, now: NOW });
    expect(Object.keys(result).sort()).toEqual(['deleted', 'expired', 'revoked', 'total']);
  });
});

describe('invites:purge · el CLI', () => {
  const src = readFileSync(join(__dirname, '..', 'prisma', 'scripts', 'invites-purge.ts'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const rootPkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));

  it('simula por defecto: solo borra con --yes, y --dry-run gana a --yes', () => {
    expect(src).toContain("const APPLY = args.includes('--yes') && !args.includes('--dry-run');");
  });

  it('no imprime correos ni filas: solo recuentos y errores sin datos de Prisma', () => {
    expect(src).not.toMatch(/\bemail\b/);
    expect(src).not.toMatch(/findMany|findFirst|findUnique/);
    expect(src).toContain('describeScriptError(error)');
  });

  it('está en los scripts de la API y con alias en la raíz', () => {
    expect(pkg.scripts['invites:purge']).toBe('tsx prisma/scripts/invites-purge.ts');
    expect(rootPkg.scripts['invites:purge']).toBe('npm --workspace @asepsico/api run invites:purge --');
  });
});
