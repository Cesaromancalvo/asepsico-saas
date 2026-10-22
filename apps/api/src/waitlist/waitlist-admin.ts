import { isAbsolute, relative, resolve } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import { decryptModel } from '../common/crypto/clinical-crypto';
import { DECRYPTION_FAILED_PLACEHOLDER } from '../common/crypto/field-encryption';
import { hashWaitlistEmail } from './waitlist-crypto';

/**
 * Gestión de la lista de espera para César: por CLI (prisma/scripts/waitlist-*.ts) y, desde el
 * panel privado, por la API de plataforma (src/platform/, solo PLATFORM_ADMIN). Aquí vive la lógica
 * compartida para poder probarla sin base de datos. Ninguna función registra valores personales.
 */

export const WAITLIST_CSV_COLUMNS = [
  'createdAt', 'name', 'email', 'situation', 'tools', 'professionalsCount', 'source',
  'privacyPolicyVersion', 'privacyAcceptedAt',
  'commercialConsentRequested', 'commercialConsentRequestedAt',
  'commercialConsent', 'commercialConsentAt', 'commercialConsentWithdrawnAt',
] as const;

type Row = Record<string, unknown>;

/**
 * Celda CSV (RFC 4180) a prueba de inyección de fórmulas: un valor que empiece por = + - @,
 * tabulador o retorno se prefija con ' para que Excel/Sheets no lo ejecute al abrir el archivo.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function waitlistCsv(rows: Row[]): { csv: string; unreadable: number } {
  let unreadable = 0;
  const lines = [WAITLIST_CSV_COLUMNS.join(',')];
  for (const raw of rows) {
    const row = decryptModel('waitlistEntry', raw);
    if ([row.name, row.email, row.tools].includes(DECRYPTION_FAILED_PLACEHOLDER)) unreadable++;
    lines.push(WAITLIST_CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  return { csv: `${lines.join('\r\n')}\r\n`, unreadable };
}

/**
 * Ruta de salida del export: absoluta (relativa al directorio desde el que se lanzó npm, INIT_CWD)
 * y SIEMPRE fuera del repositorio, para que el CSV descifrado no acabe en un commit.
 */
export function resolveExportPath(out: string | undefined, repoRoot: string, cwd: string = process.env.INIT_CWD ?? process.cwd()): string {
  if (!out) throw new Error('Indica la ruta de salida con --out <ruta fuera del repo>');
  const target = resolve(cwd, out);
  const rel = relative(resolve(repoRoot), target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error('La ruta de salida está dentro del repositorio: elige una fuera (el CSV contiene datos personales en claro)');
  }
  return target;
}

export async function exportWaitlist(prisma: PrismaClient) {
  const rows = await prisma.waitlistEntry.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: Object.fromEntries(WAITLIST_CSV_COLUMNS.map((c) => [c, true])) as Record<(typeof WAITLIST_CSV_COLUMNS)[number], true>,
  });
  return { ...waitlistCsv(rows), count: rows.length };
}

/** Lo que queda de una fila suprimida: ningún dato personal, ni siquiera el hash del email. */
function suppressedData(now: Date) {
  return {
    name: null,
    email: null,
    emailHash: null,
    tools: null,
    professionalsCount: null,
    situation: null,
    source: null,
    commercialConsentRequested: false,
    commercialConsentRequestedAt: null,
    commercialConsent: false,
    commercialConsentAt: null,
    commercialConsentWithdrawnAt: null,
    deletedAt: now,
  };
}

/**
 * Supresión (art. 17 RGPD): vacía TODOS los datos personales de la fila (también emailHash, que
 * es un seudónimo del email) y deja solo la marca deletedAt con datos no identificativos. Si la
 * persona vuelve a apuntarse, se crea una alta nueva.
 */
export async function deleteWaitlistEntry(prisma: PrismaClient, email: string, now: Date = new Date()): Promise<number> {
  const emailHash = hashWaitlistEmail(email);
  const result = await prisma.waitlistEntry.updateMany({ where: { emailHash, deletedAt: null }, data: suppressedData(now) });
  return result.count;
}

/**
 * La misma supresión, por id de fila (panel privado, POST /api/v1/admin/waitlist/:id/delete).
 * Solo afecta a una fila ACTIVA: devuelve 0 si no existe o ya estaba suprimida. Acepta el cliente
 * de una transacción para escribir la auditoría en la misma transacción.
 */
export async function suppressWaitlistEntryById(
  db: Pick<PrismaClient, 'waitlistEntry'> | Pick<Prisma.TransactionClient, 'waitlistEntry'>,
  id: string,
  now: Date = new Date(),
): Promise<number> {
  const result = await db.waitlistEntry.updateMany({ where: { id, deletedAt: null }, data: suppressedData(now) });
  return result.count;
}

export type CommercialConsentResult = 'confirmed' | 'withdrawn' | 'not-found' | 'not-requested';

/**
 * Doble opt-in manual: César lo ejecuta cuando la persona responde "Sí" al email de confirmación.
 * Solo confirma si la casilla se marcó en el formulario (commercialConsentRequested) y no se
 * retiró después. Es la ÚNICA vía que pone commercialConsent=true.
 */
export async function confirmCommercialConsent(prisma: PrismaClient, email: string, now: Date = new Date()): Promise<CommercialConsentResult> {
  const emailHash = hashWaitlistEmail(email);
  const result = await prisma.waitlistEntry.updateMany({
    where: { emailHash, deletedAt: null, commercialConsentRequested: true },
    data: { commercialConsent: true, commercialConsentAt: now, commercialConsentWithdrawnAt: null },
  });
  if (result.count) return 'confirmed';
  const exists = await prisma.waitlistEntry.count({ where: { emailHash, deletedAt: null } });
  return exists ? 'not-requested' : 'not-found';
}

/**
 * Retirada del consentimiento comercial (y de la solicitud, para que no se pueda volver a
 * confirmar sin una nueva petición expresa). Solo por CLI o por el futuro enlace de baja; el
 * formulario público no puede retirarlo ni concederlo.
 */
export async function withdrawCommercialConsent(prisma: PrismaClient, email: string, now: Date = new Date()): Promise<CommercialConsentResult> {
  const emailHash = hashWaitlistEmail(email);
  const result = await prisma.waitlistEntry.updateMany({
    where: { emailHash, deletedAt: null },
    data: { commercialConsent: false, commercialConsentAt: null, commercialConsentRequested: false, commercialConsentRequestedAt: null, commercialConsentWithdrawnAt: now },
  });
  return result.count ? 'withdrawn' : 'not-found';
}

/** Fecha de corte: altas creadas antes de hace `months` meses (0 = todas las altas activas). */
export function purgeCutoff(months: number, now: Date = new Date()): Date {
  if (!Number.isInteger(months) || months < 0 || months > 120) throw new Error('--older-than-months debe ser un entero entre 0 y 120');
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

/**
 * Purga por plazo de conservación (política: máximo 12 meses desde el alta, o 3 meses tras el
 * lanzamiento público, lo que ocurra antes). Se cuenta desde createdAt (la primera alta), que es
 * lo más prudente. Misma supresión que deleteWaitlistEntry. Con dryRun solo cuenta.
 */
export async function purgeWaitlist(prisma: PrismaClient, months: number, options: { dryRun?: boolean; now?: Date } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const where = { deletedAt: null, createdAt: { lt: purgeCutoff(months, now) } };
  if (options.dryRun) return prisma.waitlistEntry.count({ where });
  const result = await prisma.waitlistEntry.updateMany({ where, data: suppressedData(now) });
  return result.count;
}
