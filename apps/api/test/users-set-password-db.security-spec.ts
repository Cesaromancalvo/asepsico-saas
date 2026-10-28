import { PrismaClient } from '@prisma/client';
import { compare, hash } from 'bcryptjs';
import { assertActiveSession } from '../src/common/auth/active-session';
import {
  MFA_RESET_CLI_ACTION, PASSWORD_RESET_CLI_ACTION, SetPasswordError, setUserPassword,
} from '../prisma/scripts/set-password/set-password-core';

/**
 * users:set-password contra PostgreSQL REAL: transacción, tokenVersion (el JwtAuthGuard rechaza el
 * access token viejo), passwordChangedAt, desbloqueo del MFA, --reset-mfa, revocación de refresh
 * tokens, auditoría solo en membresías ACTIVE y modo demo por defecto.
 *
 * Como los demás *-db: solo con RACE_DATABASE_URL (BD DESECHABLE ya migrada); con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Datos 100 % ficticios.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de users:set-password no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(60_000);

describeDb('users:set-password (PostgreSQL real)', () => {
  const run = `setpw-${Date.now()}`;
  const NEW_PASSWORD = 'ficticia-larga-0123456789';
  let prisma: PrismaClient;
  const ids: Record<string, string> = {};

  const createUser = async (key: string, isDemo: boolean) => {
    const user = await prisma.user.create({
      data: {
        email: `${run}-${key}@example.test`, passwordHash: await hash('vieja-ficticia-0123456', 4), firstName: 'Usuario', lastName: 'Ficticio',
        isDemo, tokenVersion: 2, mfaFailedAttempts: 5, mfaLockedUntil: new Date(Date.now() + 3_600_000),
        totpEnabled: true, totpSecret: 'enc:secreto-ficticio-no-valido', mfaRecoveryCodes: ['hash-ficticio-1'], totpLastUsedStep: 42,
      },
    });
    await prisma.workspaceMember.create({ data: { workspaceId: ids.wsActive, userId: user.id, role: 'THERAPIST', isClinician: true } });
    await prisma.workspaceMember.create({
      data: { workspaceId: ids.wsRemoved, userId: user.id, role: 'THERAPIST', isClinician: true, status: 'REMOVED', removedAt: new Date() },
    });
    for (const n of [1, 2]) {
      await prisma.refreshToken.create({
        data: { userId: user.id, workspaceId: ids.wsActive, tokenHash: `${run}-${key}-${n}`, family: `${run}-${key}`, expiresAt: new Date(Date.now() + 86_400_000) },
      });
    }
    ids[key] = user.id;
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    ids.wsActive = (await prisma.workspace.create({ data: { name: `Consulta demo ficticia ${run}` } })).id;
    ids.wsRemoved = (await prisma.workspace.create({ data: { name: `Consulta antigua ficticia ${run}` } })).id;
    await createUser('demo', true);
    await createUser('real', false);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const userOf = (key: string) => prisma.user.findUniqueOrThrow({ where: { id: ids[key] } });
  const auditsOf = (key: string) => prisma.auditLog.findMany({ where: { entityId: ids[key], action: { in: [PASSWORD_RESET_CLI_ACTION, MFA_RESET_CLI_ACTION] } } });

  it('modo demo por defecto: una cuenta real se rechaza y no cambia nada', async () => {
    const before = await userOf('real');
    await expect(setUserPassword(prisma, { email: `${run}-real@example.test`, password: NEW_PASSWORD })).rejects.toBeInstanceOf(SetPasswordError);
    const after = await userOf('real');
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(2);
    expect(await auditsOf('real')).toHaveLength(0);
  });

  it('demo: cambia el hash, sube tokenVersion (el access token viejo deja de valer), desbloquea y revoca', async () => {
    const tokenBefore = { sub: ids.demo, workspaceId: ids.wsActive, tv: 2 };
    await expect(assertActiveSession(prisma as any, tokenBefore)).resolves.toBeUndefined();

    const result = await setUserPassword(prisma, { email: `${run}-DEMO@example.test`, password: NEW_PASSWORD });
    expect(result).toMatchObject({ revokedSessions: 2, auditedWorkspaces: 1, mfaReset: false });

    const u = await userOf('demo');
    expect(await compare(NEW_PASSWORD, u.passwordHash)).toBe(true);
    expect(u.tokenVersion).toBe(3);
    expect(u.passwordChangedAt).toBeInstanceOf(Date);
    expect(u.mfaFailedAttempts).toBe(0);
    expect(u.mfaLockedUntil).toBeNull();
    expect(u.totpEnabled).toBe(true); // sin --reset-mfa el TOTP se conserva
    expect(u.totpSecret).toBe('enc:secreto-ficticio-no-valido');

    await expect(assertActiveSession(prisma as any, tokenBefore)).rejects.toMatchObject({ response: { code: 'SESSION_REVOKED' } });
    expect(await prisma.refreshToken.count({ where: { userId: ids.demo, revokedAt: null } })).toBe(0);

    const audits = await auditsOf('demo');
    expect(audits.map((a) => [a.workspaceId, a.action])).toEqual([[ids.wsActive, PASSWORD_RESET_CLI_ACTION]]); // nada en la baja
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(`${run}-demo@example.test`);
    expect(serialized).not.toContain(NEW_PASSWORD);
    expect(serialized).not.toContain('secreto-ficticio');
    expect(serialized).not.toMatch(/\$2[aby]\$/);
  });

  it('cuenta real con allowNonDemo y resetMfa (§3.7): borra el TOTP y audita los dos eventos', async () => {
    const result = await setUserPassword(prisma, { email: `${run}-real@example.test`, password: NEW_PASSWORD, allowNonDemo: true, resetMfa: true });
    expect(result).toMatchObject({ mfaReset: true, auditedWorkspaces: 1, revokedSessions: 2 });
    const u = await userOf('real');
    expect(u).toMatchObject({ totpEnabled: false, totpSecret: null, mfaRecoveryCodes: [], totpLastUsedStep: null, tokenVersion: 3, mfaFailedAttempts: 0 });
    const audits = await auditsOf('real');
    expect(audits.map((a) => a.action).sort()).toEqual([MFA_RESET_CLI_ACTION, PASSWORD_RESET_CLI_ACTION].sort());
    expect(audits.every((a) => a.workspaceId === ids.wsActive && a.actorId === null)).toBe(true);
    expect(audits.find((a) => a.action === PASSWORD_RESET_CLI_ACTION)!.metadata).toEqual({ via: 'cli', revokedSessions: 2, demoAccount: false, mfaReset: true });
  });
});
