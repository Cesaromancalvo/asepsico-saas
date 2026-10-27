import { isAbsolute, relative, resolve } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import { decryptModel, encryptModelData } from '../common/crypto/clinical-crypto';
import { DECRYPTION_FAILED_PLACEHOLDER } from '../common/crypto/field-encryption';
import { PLATFORM_AUDIT_ACTIONS, writePlatformAudit } from '../platform/platform-audit';
import { hashWaitlistEmail } from './waitlist-crypto';
import { normalizeWaitlistPhone } from './waitlist-phone';

/**
 * Gestión de la lista de espera para César: por CLI (prisma/scripts/waitlist-*.ts) y, desde el
 * panel privado, por la API de plataforma (src/platform/, solo PLATFORM_ADMIN). Aquí vive la lógica
 * compartida para poder probarla sin base de datos. Ninguna función registra valores personales.
 */

/**
 * Columnas del export por defecto: SIN teléfono (condición de Argos). El teléfono solo sale con
 * --with-phone explícito (WAITLIST_CSV_COLUMNS_WITH_PHONE, justo después de email).
 */
export const WAITLIST_CSV_COLUMNS = [
  'createdAt', 'name', 'email', 'situation', 'tools', 'professionalsCount', 'source',
  'privacyPolicyVersion', 'privacyAcceptedAt',
  'commercialConsentRequested', 'commercialConsentRequestedAt',
  'commercialConsent', 'commercialConsentAt', 'commercialConsentWithdrawnAt',
] as const;

export const WAITLIST_CSV_COLUMNS_WITH_PHONE = [
  ...WAITLIST_CSV_COLUMNS.slice(0, WAITLIST_CSV_COLUMNS.indexOf('email') + 1),
  'phone',
  ...WAITLIST_CSV_COLUMNS.slice(WAITLIST_CSV_COLUMNS.indexOf('email') + 1),
] as const;

type CsvColumn = (typeof WAITLIST_CSV_COLUMNS_WITH_PHONE)[number];

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

export function waitlistCsv(rows: Row[], columns: readonly CsvColumn[] = WAITLIST_CSV_COLUMNS): { csv: string; unreadable: number } {
  let unreadable = 0;
  const lines = [columns.join(',')];
  for (const raw of rows) {
    const row = decryptModel('waitlistEntry', raw);
    if (columns.some((column) => row[column] === DECRYPTION_FAILED_PLACEHOLDER)) unreadable++;
    lines.push(columns.map((column) => csvCell(row[column])).join(','));
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

/**
 * Export del CLI waitlist:export. Lee las altas activas, genera el CSV, deja
 * PLATFORM_WAITLIST_EXPORTED (solo recuento y si lleva teléfono; sin actor ni datos personales) y
 * llama a `write` con el CSV, todo en la MISMA transacción: si escribir el archivo falla, no queda
 * auditoría de un export que no ha ocurrido. Si falla el commit tras escribir, quien llama borra
 * el archivo.
 */
export async function exportWaitlist(prisma: PrismaClient, options: { withPhone?: boolean; write?: (csv: string) => void } = {}) {
  const withPhone = options.withPhone === true;
  const columns = withPhone ? WAITLIST_CSV_COLUMNS_WITH_PHONE : WAITLIST_CSV_COLUMNS;
  return prisma.$transaction(async (tx) => {
    const rows = await tx.waitlistEntry.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: Object.fromEntries(columns.map((c) => [c, true])) as Record<CsvColumn, true>,
    });
    const result = waitlistCsv(rows, columns);
    await writePlatformAudit(tx, { actorId: null, action: PLATFORM_AUDIT_ACTIONS.WAITLIST_EXPORTED, entityType: 'WaitlistEntry', metadata: { count: rows.length, withPhone } });
    options.write?.(result.csv);
    return { ...result, count: rows.length };
  }, { timeout: 30_000 });
}

/** Lo que queda de una fila suprimida: ningún dato personal, ni siquiera el hash del email. */
function suppressedData(now: Date) {
  return {
    name: null,
    email: null,
    emailHash: null,
    phone: null,
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

type WaitlistTxDb = Pick<Prisma.TransactionClient, 'waitlistEntry' | 'platformAuditLog'>;

/** Busca el id de la alta ACTIVA con ese email (por emailHash); nunca descifra ni devuelve datos. */
async function activeEntryIdByEmail(db: Pick<Prisma.TransactionClient, 'waitlistEntry'>, email: string): Promise<string | null> {
  const row = await db.waitlistEntry.findFirst({ where: { emailHash: hashWaitlistEmail(email), deletedAt: null }, select: { id: true } });
  return row?.id ?? null;
}

export type SetPhoneResult = 'updated' | 'not-found' | 'invalid';

/**
 * Rectificación (art. 16) o alta del teléfono de una persona ya apuntada que lo da por email
 * (los 3 apuntados v2–v4, spec §8 y P4 de Lex). Valida y normaliza con la MISMA regla que la API,
 * lo cifra y escribe solo en la fila activa con ese email, con auditoría en PlatformAuditLog en la
 * misma transacción (sin el teléfono ni el email). La versión de la política de la fila no cambia.
 */
export async function setWaitlistPhone(prisma: PrismaClient, email: string, rawPhone: string): Promise<SetPhoneResult> {
  const phone = normalizeWaitlistPhone(rawPhone);
  if (!phone) return 'invalid';
  return prisma.$transaction(async (tx) => {
    const id = await activeEntryIdByEmail(tx, email);
    if (!id) return 'not-found';
    const result = await tx.waitlistEntry.updateMany({ where: { id, deletedAt: null }, data: encryptModelData('waitlistEntry', { phone }) });
    if (result.count !== 1) return 'not-found';
    await writePlatformAudit(tx, { actorId: null, action: PLATFORM_AUDIT_ACTIONS.WAITLIST_PHONE_SET, entityType: 'WaitlistEntry', entityId: id, metadata: { source: 'cli' } });
    return 'updated';
  });
}

export type ClearPhoneResult = 'cleared' | 'no-phone' | 'not-found';

/**
 * Borra SOLO el teléfono de una alta activa por id (retirada del consentimiento para llamadas,
 * apartado 3 de la política v5; bloqueo §3/L15 de Lex). La persona sigue en la lista. No escribe
 * auditoría: la escribe quien llama, en la misma transacción (CLI o panel, con su actor).
 */
export async function clearWaitlistPhoneById(db: Pick<Prisma.TransactionClient, 'waitlistEntry'>, id: string): Promise<ClearPhoneResult> {
  const result = await db.waitlistEntry.updateMany({ where: { id, deletedAt: null, phone: { not: null } }, data: { phone: null } });
  if (result.count === 1) return 'cleared';
  const exists = await db.waitlistEntry.count({ where: { id, deletedAt: null } });
  return exists ? 'no-phone' : 'not-found';
}

/** La misma operación por email, para el CLI (waitlist:set-phone --clear), con auditoría transaccional. */
export async function clearWaitlistPhoneByEmail(prisma: PrismaClient, email: string): Promise<ClearPhoneResult> {
  return prisma.$transaction(async (tx: WaitlistTxDb) => {
    const id = await activeEntryIdByEmail(tx, email);
    if (!id) return 'not-found';
    const result = await clearWaitlistPhoneById(tx, id);
    if (result === 'cleared') {
      await writePlatformAudit(tx, { actorId: null, action: PLATFORM_AUDIT_ACTIONS.WAITLIST_PHONE_CLEARED, entityType: 'WaitlistEntry', entityId: id, metadata: { source: 'cli' } });
    }
    return result;
  });
}
