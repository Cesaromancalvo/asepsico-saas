/**
 * Salvaguardas del seed de desarrollo (prisma/seed.ts). Hallazgo de Argos: la BD de producción se
 * sembró con la cuenta demo (OWNER) y una contraseña fija publicada en el repo y en el login.
 *
 * - El seed se NIEGA a ejecutarse si NODE_ENV=production o si DATABASE_URL no apunta a una BD
 *   local (localhost, 127.0.0.1, ::1), salvo que se pase explícitamente --allow-production-seed.
 * - La contraseña de la cuenta demo nunca es un literal: sale de SEED_DEMO_PASSWORD o se genera
 *   aleatoria en cada ejecución.
 */
import { randomBytes } from 'node:crypto';
import { isLocalDatabaseUrl } from './scripts/demo/demo-guards';

export const ALLOW_PRODUCTION_SEED_FLAG = '--allow-production-seed';
export const SEED_PASSWORD_ENV = 'SEED_DEMO_PASSWORD';
export const MIN_SEED_PASSWORD_LENGTH = 12;

export class SeedRefusal extends Error {}

export function assertSeedAllowed(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): void {
  if (argv.includes(ALLOW_PRODUCTION_SEED_FLAG)) return;
  if (env.NODE_ENV === 'production') {
    throw new SeedRefusal(`NODE_ENV=production: el seed de desarrollo no se ejecuta en producción (usa ${ALLOW_PRODUCTION_SEED_FLAG} solo si sabes lo que haces).`);
  }
  if (!isLocalDatabaseUrl(env.DATABASE_URL)) {
    throw new SeedRefusal(`DATABASE_URL no apunta a una base de datos local: el seed se niega a escribir (usa ${ALLOW_PRODUCTION_SEED_FLAG} solo si sabes lo que haces).`);
  }
}

export interface SeedPassword { password: string; generated: boolean }

/** Contraseña de la cuenta demo: SEED_DEMO_PASSWORD si existe; si no, una aleatoria. */
export function resolveSeedPassword(env: NodeJS.ProcessEnv = process.env): SeedPassword {
  const fromEnv = env[SEED_PASSWORD_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    if (fromEnv.length < MIN_SEED_PASSWORD_LENGTH) {
      throw new SeedRefusal(`${SEED_PASSWORD_ENV} debe tener al menos ${MIN_SEED_PASSWORD_LENGTH} caracteres.`);
    }
    return { password: fromEnv, generated: false };
  }
  return { password: randomBytes(18).toString('base64url'), generated: true };
}
