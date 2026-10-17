import { Prisma } from '@prisma/client';
import { encryptField } from '../common/crypto/field-encryption';
import { retentionUntil } from './exceptional-access.policy';

/**
 * H5 (CA5.1): los registros antiguos de POST /patients/:id/exceptional-access guardaban el
 * motivo en claro en AuditLog.metadata.reason. Por cada uno:
 *  1. se crea un ExceptionalAccessJustification con el texto CIFRADO, código DATA_INCIDENT,
 *     marcado como migrado (migratedFromAuditLogId), cerrado desde su creación y SIN sesión: no
 *     concede ningún acceso (ClinicalAccessService excluye los migrados);
 *  2. se reescribe la metadata del AuditLog sin `reason`: { reasonCode, role, exceptionalAccessId, migrated }.
 * Las dos cosas en la misma transacción. Idempotente (clave única por AuditLog y solo filas que
 * aún tienen `reason`). Nunca registra el texto: solo recuentos. Las filas sin paciente o sin
 * actor (`skipped`) no generan registro, pero también pierden `reason` (reasonDiscarded: true).
 */

type MigrationDb = {
  auditLog: Pick<Prisma.TransactionClient['auditLog'], 'findMany' | 'updateMany'>;
  $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
};

export const LEGACY_EXCEPTIONAL_ACTION = 'EXCEPTIONAL_CLINICAL_ACCESS';

export async function migrateLegacyExceptionalReasons(db: MigrationDb, options: { dryRun?: boolean; batchSize?: number } = {}) {
  const batchSize = options.batchSize ?? 200;
  const result = { found: 0, migrated: 0, skipped: 0 };
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.auditLog.findMany({
      where: { action: LEGACY_EXCEPTIONAL_ACTION, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, workspaceId: true, actorId: true, entityId: true, metadata: true, createdAt: true },
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      const metadata = (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}) as Record<string, unknown>;
      if (typeof metadata.reason !== 'string') continue;
      result.found += 1;
      const role = metadata.role === 'ADMIN' ? 'ADMIN' : 'OWNER';
      // Sin paciente o sin actor no se puede crear el registro: el texto se DESCARTA igualmente
      // (nunca se deja en claro) y la fila queda marcada. El dry-run también los cuenta.
      if (!row.entityId || !row.actorId) {
        result.skipped += 1;
        if (options.dryRun) continue;
        await db.auditLog.updateMany({
          where: { id: row.id, workspaceId: row.workspaceId, action: LEGACY_EXCEPTIONAL_ACTION },
          data: { metadata: { reasonCode: 'DATA_INCIDENT', role, migrated: false, reasonDiscarded: true } },
        });
        continue;
      }
      if (options.dryRun) continue;
      await db.$transaction(async (tx) => {
        const existing = await tx.exceptionalAccessJustification.findFirst({ where: { migratedFromAuditLogId: row.id, workspaceId: row.workspaceId }, select: { id: true } });
        const record = existing ?? await tx.exceptionalAccessJustification.create({
          data: {
            workspaceId: row.workspaceId,
            patientId: row.entityId!,
            actorId: row.actorId!,
            actorRole: role,
            actorIsClinician: false,
            reasonCode: 'DATA_INCIDENT',
            justification: encryptField(metadata.reason as string)!,
            authSessionId: null,
            createdAt: row.createdAt,
            expiresAt: row.createdAt,
            closedAt: row.createdAt,
            closeReason: 'MIGRATED',
            retentionUntil: retentionUntil(row.createdAt),
            ownerCountAtCreation: 0,
            migratedFromAuditLogId: row.id,
          },
          select: { id: true },
        });
        await tx.auditLog.updateMany({
          where: { id: row.id, workspaceId: row.workspaceId, action: LEGACY_EXCEPTIONAL_ACTION },
          data: { metadata: { reasonCode: 'DATA_INCIDENT', role, exceptionalAccessId: record.id, migrated: true } },
        });
      });
      result.migrated += 1;
    }
  }
  return result;
}
