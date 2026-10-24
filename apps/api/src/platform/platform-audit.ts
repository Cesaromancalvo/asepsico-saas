import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Auditoría de plataforma (tabla PlatformAuditLog, sin workspaceId, sin IP ni user-agent).
 * La metadata es una lista cerrada por acción: solo recuentos u operaciones. NUNCA nombre, email,
 * emailHash, herramientas, notas, contraseñas ni códigos.
 */
export const PLATFORM_AUDIT_ACTIONS = {
  WAITLIST_VIEWED: 'PLATFORM_WAITLIST_VIEWED',
  WAITLIST_ENTRY_SUPPRESSED: 'PLATFORM_WAITLIST_ENTRY_SUPPRESSED',
  REAUTH_FAILED: 'PLATFORM_REAUTH_FAILED',
  ACCESS_DENIED: 'PLATFORM_ACCESS_DENIED',
} as const;

export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[keyof typeof PLATFORM_AUDIT_ACTIONS];

type PlatformAuditMetadata =
  | { action: 'PLATFORM_WAITLIST_VIEWED'; metadata: { activeCount: number } }
  | { action: 'PLATFORM_WAITLIST_ENTRY_SUPPRESSED'; metadata: Record<string, never> }
  | { action: 'PLATFORM_REAUTH_FAILED'; metadata: { operation: 'waitlist-delete' } }
  | { action: 'PLATFORM_ACCESS_DENIED'; metadata: Record<string, never> };

export type PlatformAuditEntry = PlatformAuditMetadata & { actorId: string | null; entityType: 'WaitlistEntry' | 'PlatformAdmin'; entityId?: string };

type AuditDb = Pick<PrismaClient, 'platformAuditLog'> | Pick<Prisma.TransactionClient, 'platformAuditLog'>;

export function writePlatformAudit(db: AuditDb, entry: PlatformAuditEntry) {
  return db.platformAuditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata as Prisma.InputJsonValue,
    },
  });
}
