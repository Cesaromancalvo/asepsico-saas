/**
 * Comprobaciones comunes de db:seed-demo-workspace y db:purge-demo-workspace. Todo falla en cerrado:
 * ante cualquier duda, el script se niega a escribir y explica por qué (sin datos ni secretos).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { decryptFieldStrict } from '../../../src/common/crypto/field-encryption';

export class DemoRefusal extends Error {}

type Db = PrismaClient | Prisma.TransactionClient;

export function cliArg(argv: string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

export interface DemoTargetArgs { workspaceId?: string; ownerEmail?: string }

/** Exactamente uno de --workspace-id o --owner-email. */
export function parseTargetArgs(argv: string[]): DemoTargetArgs {
  const workspaceId = cliArg(argv, 'workspace-id')?.trim();
  const ownerEmail = cliArg(argv, 'owner-email')?.trim().toLowerCase();
  if (Boolean(workspaceId) === Boolean(ownerEmail)) {
    throw new DemoRefusal('Indica exactamente uno: --workspace-id <id> o --owner-email <correo del titular>.');
  }
  if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new DemoRefusal('--owner-email no es un correo válido.');
  return { workspaceId, ownerEmail };
}

/**
 * Solo con DEMO_ENVIRONMENT=true EXACTO (más estricto que el aviso de la web, que solo se quita
 * con "false"): sin definir, vacío o cualquier otro valor → se niega.
 */
export function assertDemoEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.DEMO_ENVIRONMENT !== 'true') {
    throw new DemoRefusal('DEMO_ENVIRONMENT no es "true": este script solo se ejecuta en un entorno de demostración.');
  }
}

export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Contra una BD que no es local hay que pasar la clave de cifrado de ESE entorno: si no, los
 * campos se cifrarían con la clave de desarrollo y la API no podría leerlos (y su autocomprobación
 * de arranque fallaría al tomar como muestra justo estos datos, que son los más recientes).
 */
export function assertEncryptionConfigured(env: NodeJS.ProcessEnv = process.env) {
  if (env.FIELD_ENCRYPTION_KEY || env.FIELD_ENCRYPTION_KEYS) return;
  if (isLocalDatabaseUrl(env.DATABASE_URL)) return;
  throw new DemoRefusal('Falta FIELD_ENCRYPTION_KEY (o FIELD_ENCRYPTION_KEYS): usa la misma clave que la API de este entorno.');
}

/** Muestras cifradas existentes: si hay alguna y ninguna se descifra, la clave no es la de la BD. */
const KEY_SAMPLES: { model: string; field: string }[] = [
  { model: 'session', field: 'notes' },
  { model: 'clinicalProcess', field: 'internalNotes' },
  { model: 'patient', field: 'consultationReason' },
  { model: 'message', field: 'body' },
  { model: 'clinicalHistory', field: 'currentProblem' },
];

export async function assertEncryptionKeyMatchesDatabase(db: Db) {
  let checked = 0;
  let ok = 0;
  for (const { model, field } of KEY_SAMPLES) {
    const row = await (db as any)[model].findFirst({ where: { [field]: { startsWith: 'enc:' } }, orderBy: { createdAt: 'desc' }, select: { [field]: true } });
    if (!row?.[field]) continue;
    checked++;
    try { decryptFieldStrict(row[field]); ok++; } catch { /* sin valores en el mensaje */ }
  }
  if (checked > 0 && ok === 0) {
    throw new DemoRefusal('La clave de cifrado configurada no descifra los datos existentes de esta BD: no se escribe nada.');
  }
}

export interface DemoTarget { workspaceId: string; workspaceName: string; ownerUserId: string; ownerMemberId: string; ownerIsClinician: boolean }

/** Resuelve el workspace y su titular (OWNER). Si es ambiguo, se niega. */
export async function resolveDemoTarget(db: Db, args: DemoTargetArgs): Promise<DemoTarget> {
  let workspaceId = args.workspaceId;
  if (args.ownerEmail) {
    const user = await db.user.findUnique({ where: { email: args.ownerEmail }, select: { id: true } });
    const owned = user ? await db.workspaceMember.findMany({ where: { userId: user.id, role: 'OWNER' }, select: { workspaceId: true } }) : [];
    if (owned.length === 0) throw new DemoRefusal('No hay ningún espacio cuyo titular tenga ese correo.');
    if (owned.length > 1) throw new DemoRefusal('Ese correo es titular de varios espacios: usa --workspace-id.');
    workspaceId = owned[0].workspaceId;
  }
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId! }, select: { id: true, name: true } });
  if (!workspace) throw new DemoRefusal('Espacio no encontrado.');
  const owners = await db.workspaceMember.findMany({
    where: { workspaceId: workspace.id, role: 'OWNER' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userId: true, isClinician: true },
  });
  if (owners.length !== 1) throw new DemoRefusal('El espacio no tiene exactamente un titular (OWNER): no se toca.');
  return { workspaceId: workspace.id, workspaceName: workspace.name, ownerUserId: owners[0].userId, ownerMemberId: owners[0].id, ownerIsClinician: owners[0].isClinician };
}

/** Pacientes NO marcados como demo (incluidos archivados o con borrado lógico). */
export async function countRealPatients(db: Db, workspaceId: string): Promise<number> {
  return db.patient.count({ where: { workspaceId, isDemo: false } });
}

export async function assertNoRealPatients(db: Db, workspaceId: string) {
  if ((await countRealPatients(db, workspaceId)) > 0) {
    throw new DemoRefusal('El espacio tiene pacientes que no son de demostración: no se siembra nada.');
  }
}

/** Mensaje de error apto para la terminal: nunca vuelca objetos, consultas ni valores. */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof DemoRefusal) return error.message;
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? `error de base de datos ${code}` : 'error inesperado (sin detalles para no volcar datos)';
}
