/**
 * Salvaguardas del seed de desarrollo (prisma/seed.ts). Hallazgo de Argos: la BD de producción se
 * sembró con la cuenta demo (OWNER) y una contraseña fija publicada en el repo y en el login.
 *
 * - El seed se NIEGA a ejecutarse si NODE_ENV=production o si DATABASE_URL no apunta a una BD
 *   local (localhost, 127.0.0.1, ::1), salvo que se pase explícitamente --allow-production-seed.
 * - Segunda barrera (condición de Argos), SIEMPRE activa, también con el flag: antes de escribir,
 *   si la BD tiene algún usuario que no sea demo o algún workspace distinto de "Consulta Demo",
 *   el seed se niega. Así no se salta con un túnel o un puerto de producción mapeado a 127.0.0.1.
 * - La contraseña de la cuenta demo nunca es un literal: sale de SEED_DEMO_PASSWORD o se genera
 *   aleatoria en cada ejecución.
 */
import { randomBytes } from 'node:crypto';
import { isLocalDatabaseUrl } from './scripts/demo/demo-guards';

export const ALLOW_PRODUCTION_SEED_FLAG = '--allow-production-seed';
export const SEED_PASSWORD_ENV = 'SEED_DEMO_PASSWORD';
export const MIN_SEED_PASSWORD_LENGTH = 12;
export const SEED_DEMO_EMAIL = 'demo@asepsico.es';
export const SEED_DEMO_WORKSPACE_NAME = 'Consulta Demo';

export class SeedRefusal extends Error {}

export function assertSeedAllowed(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): void {
  if (argv.includes(ALLOW_PRODUCTION_SEED_FLAG)) return;
  // "Production", " production " y similares también bloquean.
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
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

/** Lo mínimo del PrismaClient que necesita la segunda barrera (permite probarla sin BD). */
export interface SeedTargetDb {
  user: { count(args: { where: { isDemo: boolean; email: { not: string } } }): Promise<number> };
  workspace: { count(args: { where: { name: { not: string } } }): Promise<number> };
}

/**
 * Segunda barrera: la BD solo puede contener lo que siembra este seed (la cuenta demo y
 * "Consulta Demo") o usuarios ficticios marcados isDemo. Cualquier otra cosa = datos reales.
 */
export async function assertDatabaseIsDisposable(db: SeedTargetDb): Promise<void> {
  const otherUsers = await db.user.count({ where: { isDemo: false, email: { not: SEED_DEMO_EMAIL } } });
  if (otherUsers > 0) {
    throw new SeedRefusal(`la base de datos tiene ${otherUsers} usuario(s) que no son demo: el seed solo escribe en una BD desechable.`);
  }
  const otherWorkspaces = await db.workspace.count({ where: { name: { not: SEED_DEMO_WORKSPACE_NAME } } });
  if (otherWorkspaces > 0) {
    throw new SeedRefusal(`la base de datos tiene ${otherWorkspaces} workspace(s) distintos de "${SEED_DEMO_WORKSPACE_NAME}": el seed solo escribe en una BD desechable.`);
  }
}
