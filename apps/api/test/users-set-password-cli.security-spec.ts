import { compare, getRounds } from 'bcryptjs';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CliIo, CliOptions, IDENTITY_CONFIRMATION_WORD, MFA_RESET_CLI_ACTION, MIN_CLI_PASSWORD_LENGTH, parseCliArgs,
  PASSWORD_RESET_CLI_ACTION, runSetPasswordFlow, SetPasswordError, setUserPassword, validateNewPassword,
} from '../prisma/scripts/set-password/set-password-core';

// CLI users:set-password (Dora 15/10, rehecho sobre main 28/10). Datos 100 % ficticios.
const EMAIL = 'terapeuta.demo.ficticia@example.test';
const REAL_EMAIL = 'profesional.ficticia@example.test';
const NEW_PASSWORD = 'ficticia-larga-0123456789';
const REMOTE_URL = 'postgresql://u:p@db.ejemplo.invalid:5432/x';
const LOCAL_URL = 'postgresql://u:p@localhost:5432/x';
const DEMO: CliOptions = { email: EMAIL, resetMfa: false, allowNonDemo: false };

type Token = { id: string; userId: string; revokedAt: Date | null };
type Audit = Record<string, any>;
type FakeUser = Record<string, any>;

function fakeDb(opts: { memberships?: { workspaceId: string; status: 'ACTIVE' | 'REMOVED' }[]; failAudit?: boolean; raceOnUpdate?: boolean } = {}) {
  const state = {
    users: [
      {
        id: 'user-1', email: EMAIL, passwordHash: 'hash-viejo', isDemo: true, tokenVersion: 3, passwordChangedAt: null,
        mfaFailedAttempts: 4, mfaLockedUntil: new Date('2030-01-01'), totpSecret: 'cifrado-ficticio', totpEnabled: true,
        mfaRecoveryCodes: ['h1', 'h2'], totpLastUsedStep: 123,
      },
      {
        id: 'user-2', email: REAL_EMAIL, passwordHash: 'hash-otro', isDemo: false, tokenVersion: 0, passwordChangedAt: null,
        mfaFailedAttempts: 0, mfaLockedUntil: null, totpSecret: 'cifrado-ficticio-2', totpEnabled: true, mfaRecoveryCodes: ['h3'], totpLastUsedStep: 9,
      },
    ] as FakeUser[],
    tokens: [
      { id: 't1', userId: 'user-1', revokedAt: null },
      { id: 't2', userId: 'user-1', revokedAt: null },
      { id: 't3', userId: 'user-1', revokedAt: new Date('2026-01-01') },
      { id: 't4', userId: 'user-2', revokedAt: null },
    ] as Token[],
    audits: [] as Audit[],
    memberships: [
      ...(opts.memberships ?? [{ workspaceId: 'ws-1', status: 'ACTIVE' }, { workspaceId: 'ws-2', status: 'ACTIVE' }, { workspaceId: 'ws-baja', status: 'REMOVED' }])
        .map((m) => ({ userId: 'user-1', ...m })),
      { userId: 'user-2', workspaceId: 'ws-real', status: 'ACTIVE' },
    ],
  };
  const ops = {
    user: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const u = state.users.find((x) => x.email === where.email);
        return u ? Object.fromEntries(Object.keys(select).map((k) => [k, u[k]])) : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const u = state.users.find((x) => x.id === where.id)!;
        if (opts.raceOnUpdate) u.tokenVersion += 1; // otro cambio de credenciales se cruza
        const matches = Object.entries(where).every(([k, v]) => u[k] === v);
        if (!matches) return { count: 0 };
        Object.assign(u, data);
        return { count: 1 };
      }),
    },
    workspaceMember: {
      findMany: jest.fn(async ({ where, select }: any) =>
        state.memberships
          .filter((m) => m.userId === where.userId && (where.status === undefined || m.status === where.status))
          .map(({ workspaceId }) => (select.workspace ? { workspaceId, role: 'THERAPIST', workspace: { name: `Consulta Ficticia ${workspaceId}` } } : { workspaceId }))),
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

describe('users:set-password · argumentos (nada sensible por argumentos, falla cerrado)', () => {
  it('modo demo por defecto; --reset-mfa y --allow-non-demo son opciones explícitas', () => {
    expect(parseCliArgs(['--email', EMAIL], REMOTE_URL)).toEqual({ email: EMAIL, resetMfa: false, allowNonDemo: false });
    expect(parseCliArgs([`--email=${EMAIL}`, '--reset-mfa'], REMOTE_URL)).toEqual({ email: EMAIL, resetMfa: true, allowNonDemo: false });
    expect(parseCliArgs(['--allow-non-demo', '--reset-mfa'], REMOTE_URL)).toEqual({ resetMfa: true, allowNonDemo: true });
  });

  it('--allow-dev-secret y similares se rechazan, con aviso explícito contra una BD remota', () => {
    for (const flag of ['--allow-dev-secret', '--allow-dev-secrets', '--dev-secret', '--insecure', '--skip-confirm']) {
      expect(() => parseCliArgs(['--email', EMAIL, flag], REMOTE_URL)).toThrow(/remota/);
      expect(() => parseCliArgs(['--email', EMAIL, flag], LOCAL_URL)).toThrow(SetPasswordError);
    }
    expect(() => parseCliArgs(['--allow-dev-secret'], undefined)).toThrow(/remota/); // sin URL: falla cerrado
  });

  it('contraseñas, códigos o argumentos sueltos: abortan sin repetir el valor', () => {
    for (const argv of [['--password', NEW_PASSWORD], [`--new-password=${NEW_PASSWORD}`], ['--totp', '123456'], ['--mfa-code=123456'], [NEW_PASSWORD]]) {
      let message = '';
      try { parseCliArgs(argv, REMOTE_URL); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(/No se ha cambiado nada/);
      expect(message).not.toContain(NEW_PASSWORD);
      expect(message).not.toContain('123456');
    }
  });

  it('con --allow-non-demo el correo de una profesional real no va por argumentos (historial)', () => {
    expect(() => parseCliArgs(['--allow-non-demo', '--email', REAL_EMAIL], REMOTE_URL)).toThrow(/historial/);
    expect(() => parseCliArgs(['--email', REAL_EMAIL, '--allow-non-demo'], REMOTE_URL)).toThrow(/historial/);
  });

  it('opciones booleanas con valor, --email repetido o sin valor: error', () => {
    expect(() => parseCliArgs(['--reset-mfa=no'], REMOTE_URL)).toThrow(SetPasswordError);
    expect(() => parseCliArgs(['--email', EMAIL, '--email', EMAIL], REMOTE_URL)).toThrow(/una vez/);
    expect(() => parseCliArgs(['--email'], REMOTE_URL)).toThrow(/correo válido/);
  });
});

describe('users:set-password · cambio, invalidación, revocación y auditoría', () => {
  it('guarda un hash bcrypt de coste 12 que el login acepta (mismo compare de bcryptjs)', async () => {
    const { prisma, state } = fakeDb();
    await setUserPassword(prisma, { email: `  ${EMAIL.toUpperCase()} `, password: NEW_PASSWORD });
    const stored = state.users[0].passwordHash;
    expect(stored).not.toBe(NEW_PASSWORD);
    expect(getRounds(stored)).toBe(12);
    expect(await compare(NEW_PASSWORD, stored)).toBe(true);
    expect(state.users[1].passwordHash).toBe('hash-otro'); // otra cuenta intacta
  });

  it('sube tokenVersion, pone passwordChangedAt y desbloquea el MFA sin tocar el TOTP', async () => {
    const { prisma, state } = fakeDb();
    const now = new Date('2026-10-28T10:00:00Z');
    const result = await setUserPassword(prisma, { email: EMAIL, password: NEW_PASSWORD, now });
    const u = state.users[0];
    expect(u.tokenVersion).toBe(4);
    expect(u.passwordChangedAt).toEqual(now);
    expect(u.mfaFailedAttempts).toBe(0);
    expect(u.mfaLockedUntil).toBeNull();
    expect(u).toMatchObject({ totpEnabled: true, totpSecret: 'cifrado-ficticio', mfaRecoveryCodes: ['h1', 'h2'], totpLastUsedStep: 123 });
    expect(result.mfaReset).toBe(false);
    // Compare-and-set sobre la versión y el hash leídos.
    expect(prisma.user.updateMany.mock.calls[0][0].where).toEqual({ id: 'user-1', tokenVersion: 3, passwordHash: 'hash-viejo' });
  });

  it('--reset-mfa borra secreto TOTP, códigos de recuperación y último paso: tendrá que configurarlo', async () => {
    const { prisma, state } = fakeDb();
    const result = await setUserPassword(prisma, { email: EMAIL, password: NEW_PASSWORD, resetMfa: true });
    expect(state.users[0]).toMatchObject({ totpSecret: null, totpEnabled: false, mfaRecoveryCodes: [], totpLastUsedStep: null, tokenVersion: 4 });
    expect(result.mfaReset).toBe(true);
    const mfaAudits = state.audits.filter((a) => a.action === MFA_RESET_CLI_ACTION);
    expect(mfaAudits.map((a) => a.workspaceId).sort()).toEqual(['ws-1', 'ws-2']);
  });

  it('si otro cambio de credenciales se cruza (tokenVersion distinta), aborta sin cambiar nada', async () => {
    const { prisma, state } = fakeDb({ raceOnUpdate: true });
    await expect(setUserPassword(prisma, { email: EMAIL, password: NEW_PASSWORD })).rejects.toThrow(/cambió mientras tanto/);
    expect(state.users[0].passwordHash).toBe('hash-viejo');
    expect(state.tokens.filter((t) => t.userId === 'user-1' && t.revokedAt === null)).toHaveLength(2);
    expect(state.audits).toHaveLength(0);
  });

  it('revoca TODOS los RefreshToken activos del usuario y ninguno de otros', async () => {
    const { prisma, state } = fakeDb();
    const now = new Date('2026-10-16T16:00:00Z');
    const result = await setUserPassword(prisma, { email: EMAIL, password: NEW_PASSWORD, now });
    expect(result.revokedSessions).toBe(2);
    expect(state.tokens.filter((t) => t.userId === 'user-1').every((t) => t.revokedAt !== null)).toBe(true);
    expect(state.tokens.find((t) => t.id === 't3')!.revokedAt).toEqual(new Date('2026-01-01'));
    expect(state.tokens.find((t) => t.id === 't4')!.revokedAt).toBeNull();
  });

  it('audita solo en los espacios con membresía ACTIVE, sin datos personales ni secretos', async () => {
    const { prisma, state } = fakeDb();
    await setUserPassword(prisma, { email: EMAIL, password: NEW_PASSWORD, resetMfa: true });
    expect(PASSWORD_RESET_CLI_ACTION).toBe('USER_PASSWORD_RESET_CLI');
    expect(state.audits.some((a) => a.workspaceId === 'ws-baja')).toBe(false);
    const pw = state.audits.filter((a) => a.action === PASSWORD_RESET_CLI_ACTION);
    expect(pw.map((a) => a.workspaceId).sort()).toEqual(['ws-1', 'ws-2']);
    for (const audit of state.audits) {
      expect(audit).toMatchObject({ entityType: 'User', entityId: 'user-1', actorId: null });
      expect(audit.ipAddress).toBeUndefined();
      expect(audit.userAgent).toBeUndefined();
      const serialized = JSON.stringify(audit);
      for (const secret of [EMAIL, NEW_PASSWORD, 'cifrado-ficticio', 'hash-viejo', 'h1']) expect(serialized).not.toContain(secret);
      expect(serialized).not.toMatch(/\$2[aby]\$/);
    }
    expect(pw[0].metadata).toEqual({ via: 'cli', revokedSessions: 2, demoAccount: true, mfaReset: true });
  });

  it('todo en una transacción: si falla la auditoría, nada cambia (ni tokenVersion ni MFA)', async () => {
    const { prisma, state } = fakeDb({ failAudit: true });
    await expect(setUserPassword(prisma, { email: EMAIL, password: NEW_PASSWORD, resetMfa: true })).rejects.toThrow('fallo simulado');
    expect(state.users[0]).toMatchObject({ passwordHash: 'hash-viejo', tokenVersion: 3, totpEnabled: true, mfaFailedAttempts: 4 });
    expect(state.tokens.filter((t) => t.userId === 'user-1' && t.revokedAt === null)).toHaveLength(2);
    expect(state.audits).toHaveLength(0);
  });

  it('correo inexistente o sin espacio ACTIVE (solo bajas): error y nada cambia', async () => {
    const missing = fakeDb();
    await expect(setUserPassword(missing.prisma, { email: 'nadie@example.test', password: NEW_PASSWORD })).rejects.toBeInstanceOf(SetPasswordError);
    expect(missing.prisma.$transaction).not.toHaveBeenCalled();

    const removed = fakeDb({ memberships: [{ workspaceId: 'ws-baja', status: 'REMOVED' }] });
    await expect(setUserPassword(removed.prisma, { email: EMAIL, password: NEW_PASSWORD })).rejects.toThrow(/ningún espacio activo/);
    expect(removed.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('por defecto solo cuentas demo: una cuenta real exige allowNonDemo', async () => {
    const { prisma, state } = fakeDb();
    await expect(setUserPassword(prisma, { email: REAL_EMAIL, password: NEW_PASSWORD })).rejects.toThrow(/no es de demo/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await setUserPassword(prisma, { email: REAL_EMAIL, password: NEW_PASSWORD, allowNonDemo: true, resetMfa: true });
    expect(state.users[1]).toMatchObject({ tokenVersion: 1, totpEnabled: false, totpSecret: null });
    expect(state.audits.find((a) => a.action === PASSWORD_RESET_CLI_ACTION)!.metadata).toMatchObject({ demoAccount: false, mfaReset: true });
  });
});

describe('users:set-password · el CLI no expone secretos', () => {
  const cli = readFileSync(join(__dirname, '../prisma/scripts/set-user-password.ts'), 'utf8');
  const core = readFileSync(join(__dirname, '../prisma/scripts/set-password/set-password-core.ts'), 'utf8');
  const SENSITIVE = '(first|second|email|passwordHash|word|typed)';

  it('la contraseña no se acepta por argumentos ni por tubería: exige TTY y lee sin eco', () => {
    expect(cli).not.toMatch(/arg\(['"]password/);
    expect(cli).toMatch(/setRawMode\(true\)/);
    expect(cli).toMatch(/if \(!process\.stdin\.isTTY\)/);
    expect(cli).not.toMatch(/readTwoLinesFromPipe|for await \(const \w+ of process\.stdin\)/);
    // Los argumentos se validan antes de abrir la conexión.
    expect(cli.indexOf('parseCliArgs(process.argv')).toBeLessThan(cli.indexOf('new PrismaClient('));
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

  it('el proceso real rechaza --allow-dev-secret contra una BD remota y no arranca sin TTY', () => {
    const tsx = join(__dirname, '../../../node_modules/.bin/tsx');
    const script = join(__dirname, '../prisma/scripts/set-user-password.ts');
    const env = { ...process.env, DATABASE_URL: REMOTE_URL };
    const dev = spawnSync(tsx, [script, '--email', EMAIL, '--allow-dev-secret'], { env, encoding: 'utf8', input: '' });
    expect(dev.status).toBe(1);
    expect(dev.stderr).toMatch(/remota/);
    const noTty = spawnSync(tsx, [script, '--email', EMAIL], { env, encoding: 'utf8', input: `${NEW_PASSWORD}\n${NEW_PASSWORD}\n` });
    expect(noTty.status).toBe(1);
    expect(noTty.stderr).toMatch(/terminal interactiva/);
    expect(`${noTty.stdout}${noTty.stderr}${dev.stdout}${dev.stderr}`).not.toContain(EMAIL);
  }, 60_000);
});

describe('users:set-password · flujo interactivo (confirmación antes de la contraseña)', () => {
  function io(answers: string[], passwords: [string, string] = [NEW_PASSWORD, NEW_PASSWORD]) {
    const printed: string[] = [];
    const calls: string[] = [];
    let asked = 0;
    let hidden = 0;
    const cliIo: CliIo = {
      print: (line) => { printed.push(line); calls.push('print'); },
      ask: async () => { calls.push('ask'); return answers[asked++] ?? ''; },
      askHidden: async () => { calls.push('askHidden'); return passwords[hidden++]; },
    };
    return { cliIo, printed, calls };
  }

  it('demo: muestra espacio y rol de las membresías ACTIVE antes de pedir correo y contraseña', async () => {
    const { prisma } = fakeDb();
    const { cliIo, printed, calls } = io([EMAIL]);
    await runSetPasswordFlow(prisma, DEMO, cliIo);
    const out = printed.join('\n');
    expect(out).toContain('DEMO');
    expect(out).toContain('Consulta Ficticia ws-1 (rol THERAPIST)');
    expect(out).not.toContain('ws-baja');
    expect(calls.indexOf('ask')).toBeGreaterThan(calls.lastIndexOf('print'));
    expect(calls.indexOf('askHidden')).toBeGreaterThan(calls.indexOf('ask'));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('modo demo con una cuenta real: aborta antes de preguntar nada', async () => {
    const { prisma } = fakeDb();
    const { cliIo, calls } = io([REAL_EMAIL]);
    await expect(runSetPasswordFlow(prisma, { ...DEMO, email: REAL_EMAIL }, cliIo)).rejects.toThrow(/no es de demo/);
    expect(calls).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cuenta real (§3.7): correo por prompt, confirmación de identidad y después la contraseña', async () => {
    const { prisma, state } = fakeDb();
    const { cliIo, printed, calls } = io([REAL_EMAIL, REAL_EMAIL, IDENTITY_CONFIRMATION_WORD]);
    await runSetPasswordFlow(prisma, { resetMfa: true, allowNonDemo: true }, cliIo);
    expect(printed.join('\n')).toMatch(/REAL/);
    expect(printed.join('\n')).toMatch(/BORRARÁ su verificación/);
    expect(calls.filter((c) => c === 'ask')).toHaveLength(3);
    expect(calls.indexOf('askHidden')).toBeGreaterThan(calls.lastIndexOf('ask'));
    expect(state.users[1]).toMatchObject({ totpEnabled: false, tokenVersion: 1 });
  });

  it('cuenta real sin la palabra de verificación: no pide contraseña ni abre la transacción', async () => {
    const { prisma } = fakeDb();
    const { cliIo, calls } = io([REAL_EMAIL, REAL_EMAIL, 'si']);
    await expect(runSetPasswordFlow(prisma, { resetMfa: false, allowNonDemo: true }, cliIo)).rejects.toThrow(/Identidad no confirmada/);
    expect(calls).not.toContain('askHidden');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('si el correo confirmado no coincide: aborta, no pide la contraseña y no llama a $transaction', async () => {
    const { prisma, state } = fakeDb();
    const { cliIo, calls } = io(['otro.correo@example.test']);
    await expect(runSetPasswordFlow(prisma, DEMO, cliIo)).rejects.toThrow(/no coincide/);
    expect(calls).not.toContain('askHidden');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.users[0].passwordHash).toBe('hash-viejo');
  });

  it('la confirmación ignora mayúsculas y espacios en los extremos', async () => {
    const { prisma } = fakeDb();
    const { cliIo } = io([`  ${EMAIL.toUpperCase()}  `]);
    await expect(runSetPasswordFlow(prisma, DEMO, cliIo)).resolves.toMatchObject({ revokedSessions: 2 });
  });

  it('contraseñas distintas tras confirmar: no llama a $transaction', async () => {
    const { prisma } = fakeDb();
    const { cliIo } = io([EMAIL], [NEW_PASSWORD, `${NEW_PASSWORD}x`]);
    await expect(runSetPasswordFlow(prisma, DEMO, cliIo)).rejects.toThrow(/no coinciden/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('correo inexistente: aborta antes de preguntar nada', async () => {
    const { prisma } = fakeDb();
    const { cliIo, calls } = io([]);
    await expect(runSetPasswordFlow(prisma, { ...DEMO, email: 'nadie@example.test' }, cliIo)).rejects.toBeInstanceOf(SetPasswordError);
    expect(calls).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
