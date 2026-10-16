import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOW_PRODUCTION_SEED_FLAG, assertDatabaseIsDisposable, assertSeedAllowed, resolveSeedPassword, SEED_DEMO_EMAIL,
  SEED_DEMO_WORKSPACE_NAME, SeedRefusal, SeedTargetDb,
} from '../prisma/seed-guard';

/*
 * Veto de Argos: la BD de producción se sembró con la cuenta demo (OWNER de "Consulta Demo") y una
 * contraseña fija publicada. El seed de desarrollo tiene que negarse a escribir en producción o en
 * una BD no local, salvo flag explícito, y no puede llevar una contraseña literal.
 */
const LOCAL_DB = 'postgresql://asepsico:asepsico@localhost:5432/asepsico?schema=public';
const REMOTE_DB = 'postgresql://user:secret@db.ejemplo-proveedor.test:5432/asepsico';
const SEED_SOURCE = readFileSync(join(__dirname, '..', 'prisma', 'seed.ts'), 'utf8');

describe('seed: bloqueo de producción', () => {
  it('se niega con NODE_ENV=production aunque la BD sea local', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production', DATABASE_URL: LOCAL_DB }, [])).toThrow(SeedRefusal);
  });

  it('se niega contra una BD que no es local', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: REMOTE_DB }, [])).toThrow(SeedRefusal);
    expect(() => assertSeedAllowed({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@postgres:5432/db' }, [])).toThrow(SeedRefusal);
  });

  it('se niega sin DATABASE_URL o con una URL inválida', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development' }, [])).toThrow(SeedRefusal);
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: 'no-es-una-url' }, [])).toThrow(SeedRefusal);
  });

  it('permite una BD local fuera de producción (desarrollo y CI)', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: LOCAL_DB }, [])).not.toThrow();
    expect(() => assertSeedAllowed({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db' }, [])).not.toThrow();
  });

  it('solo el flag explícito permite saltarse el bloqueo (una variable de entorno no basta)', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production', DATABASE_URL: REMOTE_DB, ALLOW_PRODUCTION_SEED: 'true' }, [])).toThrow(SeedRefusal);
    expect(() => assertSeedAllowed({ NODE_ENV: 'production', DATABASE_URL: REMOTE_DB }, [ALLOW_PRODUCTION_SEED_FLAG])).not.toThrow();
  });

  it('seed.ts ejecuta la salvaguarda antes de crear el PrismaClient', () => {
    const guardIndex = SEED_SOURCE.indexOf('assertSeedAllowed()');
    const clientIndex = SEED_SOURCE.indexOf('new PrismaClient(');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(clientIndex).toBeGreaterThan(guardIndex);
    expect(SEED_SOURCE).toMatch(/process\.exit\(1\)/);
  });
});

describe('seed: contraseña de la cuenta demo', () => {
  it('seed.ts no contiene contraseñas literales', () => {
    expect(SEED_SOURCE).not.toContain('AsePsico2026!');
    expect(SEED_SOURCE).not.toMatch(/hash\(\s*['"`]/);
    expect(SEED_SOURCE).toMatch(/resolveSeedPassword\(\)/);
  });

  it('usa SEED_DEMO_PASSWORD cuando está definida', () => {
    expect(resolveSeedPassword({ SEED_DEMO_PASSWORD: 'una-de-prueba-larga' })).toEqual({ password: 'una-de-prueba-larga', generated: false });
  });

  it('rechaza una SEED_DEMO_PASSWORD corta', () => {
    expect(() => resolveSeedPassword({ SEED_DEMO_PASSWORD: 'corta' })).toThrow(SeedRefusal);
  });

  it('sin variable genera una aleatoria distinta en cada ejecución', () => {
    const a = resolveSeedPassword({});
    const b = resolveSeedPassword({});
    expect(a.generated).toBe(true);
    expect(a.password.length).toBeGreaterThanOrEqual(20);
    expect(a.password).not.toBe(b.password);
  });
});

describe('seed: condiciones de Argos al levantar el veto', () => {
  it('NODE_ENV se normaliza: "Production" y " production " también bloquean', () => {
    for (const NODE_ENV of ['Production', ' production', 'production ', 'PRODUCTION', '\tProduction\n']) {
      expect(() => assertSeedAllowed({ NODE_ENV, DATABASE_URL: LOCAL_DB }, [])).toThrow(SeedRefusal);
    }
  });

  // BD en memoria que interpreta exactamente los filtros que usa la segunda barrera.
  type FakeUser = { email: string; isDemo: boolean };
  function fakeDb(users: FakeUser[], workspaces: string[]): SeedTargetDb {
    return {
      user: { count: async ({ where }) => users.filter((u) => u.isDemo === where.isDemo && u.email !== where.email.not).length },
      workspace: { count: async ({ where }) => workspaces.filter((name) => name !== where.name.not).length },
    };
  }

  it('segunda barrera: se niega si hay algún usuario que no es demo, aunque el host sea local', async () => {
    const db = fakeDb([{ email: SEED_DEMO_EMAIL, isDemo: false }, { email: 'profesional@example.com', isDemo: false }], [SEED_DEMO_WORKSPACE_NAME]);
    await expect(assertDatabaseIsDisposable(db)).rejects.toThrow(SeedRefusal);
  });

  it('segunda barrera: se niega si hay un workspace distinto de "Consulta Demo"', async () => {
    const db = fakeDb([{ email: SEED_DEMO_EMAIL, isDemo: false }], [SEED_DEMO_WORKSPACE_NAME, 'Consulta Ficticia SL']);
    await expect(assertDatabaseIsDisposable(db)).rejects.toThrow(SeedRefusal);
  });

  it('segunda barrera: permite una BD vacía o con solo la cuenta demo, usuarios isDemo y "Consulta Demo"', async () => {
    await expect(assertDatabaseIsDisposable(fakeDb([], []))).resolves.toBeUndefined();
    const db = fakeDb([{ email: SEED_DEMO_EMAIL, isDemo: false }, { email: 'recepcion-demo@example.com', isDemo: true }], [SEED_DEMO_WORKSPACE_NAME]);
    await expect(assertDatabaseIsDisposable(db)).resolves.toBeUndefined();
  });

  it('seed.ts aplica la segunda barrera antes de la primera escritura y sin depender del flag', () => {
    const barrierIndex = SEED_SOURCE.indexOf('await assertDatabaseIsDisposable(prisma)');
    const firstWriteIndex = SEED_SOURCE.search(/prisma\.\w+\.(upsert|create|update)\(/);
    expect(barrierIndex).toBeGreaterThan(-1);
    expect(firstWriteIndex).toBeGreaterThan(barrierIndex);
    expect(SEED_SOURCE).not.toMatch(/ALLOW_PRODUCTION_SEED_FLAG[\s\S]*assertDatabaseIsDisposable/);
  });

  it('CI exige una contraseña generada de al menos 24 caracteres y verify-ci-postgres lo comprueba', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const verifier = readFileSync(join(repoRoot, 'scripts', 'verify-ci-postgres.mjs'), 'utf8');
    expect(workflow).toMatch(/^\s*\[ \$\{#pass\} -ge 24 \] \|\| exit 1\s*$/m);
    expect(verifier).toContain('-ge 24');
  });
});
