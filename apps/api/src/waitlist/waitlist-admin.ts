import { isAbsolute, relative, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { decryptModel } from '../common/crypto/clinical-crypto';
import { DECRYPTION_FAILED_PLACEHOLDER } from '../common/crypto/field-encryption';
import { hashWaitlistEmail } from './waitlist-crypto';

/**
 * Gestión de la lista de espera para César, SOLO por CLI (no hay endpoint de administración):
 * prisma/scripts/waitlist-export.ts y prisma/scripts/waitlist-delete.ts. Aquí vive la lógica
 * pura para poder probarla sin base de datos. Ninguna función registra valores personales.
 */

export const WAITLIST_CSV_COLUMNS = [
  'createdAt', 'name', 'email', 'situation', 'tools', 'professionalsCount', 'source',
  'privacyPolicyVersion', 'privacyAcceptedAt', 'commercialConsent', 'commercialConsentAt',
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

/**
 * Supresión (art. 17 RGPD): vacía TODOS los datos personales de la fila (también emailHash, que
 * es un seudónimo del email) y deja solo la marca deletedAt con datos no identificativos. Si la
 * persona vuelve a apuntarse, se crea una alta nueva.
 */
export async function deleteWaitlistEntry(prisma: PrismaClient, email: string, now: Date = new Date()): Promise<number> {
  const emailHash = hashWaitlistEmail(email);
  const result = await prisma.waitlistEntry.updateMany({
    where: { emailHash, deletedAt: null },
    data: {
      name: null,
      email: null,
      emailHash: null,
      tools: null,
      professionalsCount: null,
      situation: null,
      source: null,
      commercialConsent: false,
      commercialConsentAt: null,
      deletedAt: now,
    },
  });
  return result.count;
}
