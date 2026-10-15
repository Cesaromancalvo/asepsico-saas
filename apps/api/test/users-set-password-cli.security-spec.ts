import { compare, getRounds } from 'bcryptjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CliIo, MIN_CLI_PASSWORD_LENGTH, PASSWORD_RESET_CLI_ACTION, runSetPasswordFlow, SetPasswordError, setUserPassword, validateNewPassword,
} from '../prisma/scripts/set-password/set-password-core';

// CLI users:set-password (Dora, 15/10). Datos 100 % ficticios.
const EMAIL = 'titular.ficticio@example.test';
const NEW_PASSWORD = 'ficticia-larga-0123456789';

type Token = { id: string; userId: string; revokedAt: Date | null };
type Audit = Record<string, unknown>;

function fakeDb(opts: { memberships?: string[]; failAudit?: boolean } = {}) {
  const state = {
    users: [
      { id: 'user-1', email: EMAIL, passwordHash: 'hash-viejo' },
      { id: 'user-2', email: 'otra.persona@example.test', passwordHash: 'hash-otro' },
    ],
    tokens: [
      { id: 't1', userId: 'user-1', revokedAt: null },
      { id: 't2', userId: 'user-1', revokedAt: null },
      { id: 't3', userId: 'user-1', revokedAt: new Date('2026-01-01') },
      { id: 't4', userId: 'user-2', revokedAt: null },
    ] as Token[],
    audits: [] as Audit[],
    memberships: (opts.memberships ?? ['ws-1', 'ws-2']).map((workspaceId) => ({ userId: 'user-1', workspaceId })),
  };
  const ops = {
    user: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        expect(select).toEqual({ id: true }); // nunca lee columnas que puedan no existir aún
        const u = state.users.find((x) => x.email === where.email);
        return u ? { id: u.id } : null;
      }),
      update: jest.fn(async ({ where, data, select }: any) => {
        expect(select).toEqual({ id: true });
        const u = state.users.find((x) => x.id === where.id)!;
        u.passwordHash = data.passwordHash;
        return { id: u.id };
      }),
    },
    workspaceMember: {
      findMany: jest.fn(async ({ where, select }: any) =>
        state.memberships.filter((m) => m.userId === where.userId).map(({ workspaceId }) =>
          select.workspace ? { role: 'OWNER', workspace: { name: `Consulta Ficticia ${workspaceId}` } } : { workspaceId })),
    },
    refreshToken: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = state.tokens.filter((t) => t.userId === where.userId && t.revokedAt === where.revokedAt);
        hit.forEach((t) => (t.revokedAt = data.revokedAt));
        return { count: hit.length };
      }),
    },
    auditLog: {
      createMany: jest.fn(async ({ data }: any) => {
        if (opts.failAudit) throw new Error('fallo simulado');
        state.audits.push(...data);
        return { count: data.length };
      }),
    },
  };
  const prisma: any = {
    ...ops,
    // Transacción simulada: si el callback falla, se restaura el estado (como haría Postgres).
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const users = state.users.map((u) => ({ ...u }));
      const tokens = state.tokens.map((t) => ({ ...t }));
      const audits = [...state.audits];
      try {
        return await fn(ops);
      } catch (error) {
        state.users = users;
        state.tokens = tokens;
        state.audits = audits;
        throw error;
      }
    }),
  };
  return { prisma, state };
}

describe('users:set-password · validación de la contraseña', () => {
  it(`exige al menos ${MIN_CLI_PASSWORD_LENGTH} caracteres y que las dos coincidan`, () => {
    expect(MIN_CLI_PASSWORD_LENGTH).toBeGreaterThanOrEqual(14);
    expect(validateNewPassword('corta-1234567', 'corta-1234567')).toMatch(/14/);
    expect(validateNewPassword(NEW_PASSWORD, `${NEW_PASSWORD}x`)).toMatch(/no coinciden/);
    expect(validateNewPassword(NEW_PASSWORD, NEW_PASSWORD)).toBeNull();
  });

  it('rechaza más de 72 bytes (bcrypt los ignoraría), espacios en los extremos y caracteres de control', () => {
    const long = 'a'.repeat(73);
    expect(validateNewPassword(long, long)).toMatch(/72/);
    expect(validateNewPassword(` ${NEW_PASSWORD}`, ` ${NEW_PASSWORD}`)).toMatch(/espacios/);
    expect(validateNewPassword(`${NEW_PASSWORD}\u0007`, `${NEW_PASSWORD}\u0007`)).toMatch(/control/);
  });

  it('los mensajes de error nunca incluyen la contraseña', () => {
    const msg = validateNewPassword(NEW_PASSWORD, 'otra-distinta-0123456789') ?? '';
    expect(msg).not.toContain(NEW_PASSWORD);
  });
});

describe('users:set-password · cambio, revocación y auditoría', () => {
  it('guarda un hash bcrypt de coste 12 que el login acepta (mismo compare de bcryptjs)', async () => {
    const { prisma, state } = fakeDb();
    await setUserPassword(prisma, { email: `  ${EMAIL.toUpperCase()} `, password: NEW_PASSWORD });
    const stored = state.users[0].passwordHash;
    expect(stored).not.toBe(NEW_PASSWORD);
    expect(getRounds(stored)).toBe(12);
    expect(await compare(NEW_PASSWORD, stored)).toBe(true);
    expect(await compare('otra-cualquiera-0123456', stored)).toBe(false);
    expect(state.users[1].passwordHash).toBe('hash-otro'); // otra cuenta intacta
  });

  it('revoca TODOS los RefreshToken activos del usuario y ninguno de otros', async () => {
    const { prisma, state } = fakeDb();
    const now = new Date('2026-10-16T16:00:00Z');
    const result = await setUserPassword(prisma, { email: EMAIL, password: NEW_PASSWORD, now });
    expect(result.revokedSessions).toBe(2);
    expect(state.tokens.filter((t) => t.userId === 'user-1').every((t) => t.revokedAt !== null)).toBe(true);
    expect(state.tokens.find((t) => t.id === 't3')!.revokedAt).toEqual(new Date('2026-01-01')); // no reescribe la fecha antigua
    expect(state.tokens.find((t) => t.id === 't4')!.revokedAt).toBeNull();
  });

  it('deja un AuditLog USER_PASSWORD_RESET_CLI por espacio, sin datos personales', async () => {
    const { prisma, state } = fakeDb();
    await setUserPassword(prisma, { email: EMAIL, password: NEW_PASSWORD });
    expect(PASSWORD_RESET_CLI_ACTION).toBe('USER_PASSWORD_RESET_CLI');
    expect(state.audits).toHaveLength(2);
    expect(state.audits.map((a) => a.workspaceId).sort()).toEqual(['ws-1', 'ws-2']);
    for (const audit of state.audits) {
      expect(audit).toMatchObject({ action: 'USER_PASSWORD_RESET_CLI', entityType: 'User', entityId: 'user-1', actorId: null });
      expect(audit.ipAddress).toBeUndefined();
      expect(audit.userAgent).toBeUndefined();
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain(EMAIL);
      expect(serialized).not.toContain(NEW_PASSWORD);
      expect(serialized).not.toMatch(/\$2[aby]\$/); // ni el hash
      expect(audit.metadata).toEqual({ via: 'cli', revokedSessions: 2 });
    }
  });

  it('todo en una transacción: si falla la auditoría, ni contraseña ni sesiones cambian', async () => {
    const { prisma, state } = fakeDb({ failAudit: true });
    await expect(setUserPassword(prisma, { email: EMAIL, password: NEW_PASSWORD })).rejects.toThrow('fallo simulado');
    expect(state.users[0].passwordHash).toBe('hash-viejo');
    expect(state.tokens.filter((t) => t.userId === 'user-1' && t.revokedAt === null)).toHaveLength(2);
    expect(state.audits).toHaveLength(0);
  });

  it('correo inexistente o cuenta sin espacio: error y nada cambia', async () => {
    const missing = fakeDb();
    await expect(setUserPassword(missing.prisma, { email: 'nadie@example.test', password: NEW_PASSWORD }))
      .rejects.toBeInstanceOf(SetPasswordError);
    expect(missing.prisma.$transaction).not.toHaveBeenCalled();

    const orphan = fakeDb({ memberships: [] });
    await expect(setUserPassword(orphan.prisma, { email: EMAIL, password: NEW_PASSWORD })).rejects.toThrow(/ningún espacio/);
    expect(orphan.prisma.$transaction).not.toHaveBeenCalled();
    expect(orphan.state.users[0].passwordHash).toBe('hash-viejo');
  });
});

describe('users:set-password · el CLI no expone la contraseña', () => {
  const cli = readFileSync(join(__dirname, '../prisma/scripts/set-user-password.ts'), 'utf8');
  const core = readFileSync(join(__dirname, '../prisma/scripts/set-password/set-password-core.ts'), 'utf8');
  const SENSITIVE = '(first|second|email|passwordHash)';

  it('la contraseña no se acepta por argumentos ni por tubería: exige TTY y lee sin eco', () => {
    expect(cli).not.toMatch(/arg\(['"]password/);
    expect(cli).toMatch(/setRawMode\(true\)/);
    expect(cli).toMatch(/if \(!process\.stdin\.isTTY\)/);
    expect(cli).not.toMatch(/readTwoLinesFromPipe|for await \(const \w+ of process\.stdin\)/);
  });

  it('no imprime la contraseña, el hash ni el correo', () => {
    const logs = cli.match(/console\.\w+\([^;]*\);/g) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toMatch(new RegExp(`\\$\\{\\s*${SENSITIVE}\\b`));
      expect(line).not.toMatch(new RegExp(`[(,]\\s*${SENSITIVE}\\s*[,)]`));
    }
    expect(core).not.toMatch(/console\./);
  });

  it('usa el mismo coste bcrypt que el alta de profesionales', () => {
    const registration = readFileSync(join(__dirname, '../src/auth/registration.service.ts'), 'utf8');
    expect(registration).toMatch(/hash\(dto\.password, 12\)/);
    expect(core).toMatch(/CLI_BCRYPT_COST = 12/);
  });
});

describe('users:set-password · confirmación de la cuenta antes de la contraseña (Argos, ALTA)', () => {
  function io(answers: { email: string; passwords?: [string, string] }) {
    const printed: string[] = [];
    const calls: string[] = [];
    const pw = answers.passwords ?? [NEW_PASSWORD, NEW_PASSWORD];
    let hidden = 0;
    const cliIo: CliIo = {
      print: (line) => { printed.push(line); calls.push('print'); },
      ask: async () => { calls.push('ask'); return answers.email; },
      askHidden: async () => { calls.push('askHidden'); return pw[hidden++]; },
    };
    return { cliIo, printed, calls };
  }

  it('muestra espacio y rol de cada membresía antes de pedir el correo y la contraseña', async () => {
    const { prisma } = fakeDb();
    const { cliIo, printed, calls } = io({ email: EMAIL });
    await runSetPasswordFlow(prisma, EMAIL, cliIo);
    expect(printed.join('\n')).toContain('Consulta Ficticia ws-1 (rol OWNER)');
    expect(printed.join('\n')).toContain('Consulta Ficticia ws-2 (rol OWNER)');
    expect(calls.indexOf('ask')).toBeGreaterThan(calls.lastIndexOf('print'));
    expect(calls.indexOf('askHidden')).toBeGreaterThan(calls.indexOf('ask'));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('si el correo confirmado no coincide: aborta, no pide la contraseña y no llama a $transaction', async () => {
    const { prisma, state } = fakeDb();
    const { cliIo, calls } = io({ email: 'otro.correo@example.test' });
    await expect(runSetPasswordFlow(prisma, EMAIL, cliIo)).rejects.toThrow(/no coincide/);
    expect(calls).not.toContain('askHidden');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.users[0].passwordHash).toBe('hash-viejo');
  });

  it('la confirmación ignora mayúsculas y espacios en los extremos', async () => {
    const { prisma } = fakeDb();
    const { cliIo } = io({ email: `  ${EMAIL.toUpperCase()}  ` });
    await expect(runSetPasswordFlow(prisma, EMAIL, cliIo)).resolves.toMatchObject({ revokedSessions: 2 });
  });

  it('contraseñas distintas tras confirmar: no llama a $transaction', async () => {
    const { prisma } = fakeDb();
    const { cliIo } = io({ email: EMAIL, passwords: [NEW_PASSWORD, `${NEW_PASSWORD}x`] });
    await expect(runSetPasswordFlow(prisma, EMAIL, cliIo)).rejects.toThrow(/no coinciden/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('correo inexistente: aborta antes de preguntar nada', async () => {
    const { prisma } = fakeDb();
    const { cliIo, calls } = io({ email: 'nadie@example.test' });
    await expect(runSetPasswordFlow(prisma, 'nadie@example.test', cliIo)).rejects.toBeInstanceOf(SetPasswordError);
    expect(calls).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
