import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOW_PRODUCTION_SEED_FLAG, assertSeedAllowed, resolveSeedPassword, SeedRefusal,
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
