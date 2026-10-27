import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Auditoría de plataforma (tabla PlatformAuditLog, sin workspaceId, sin IP ni user-agent).
 * La metadata es una lista cerrada por acción: solo recuentos u operaciones. NUNCA nombre, email,
 * emailHash, teléfono, herramientas, notas, contraseñas ni códigos. Las acciones lanzadas por CLI
 * (source 'cli') no tienen actor (actorId null): las ejecuta César desde el clon de despliegue.
 */
export const PLATFORM_AUDIT_ACTIONS = {
  WAITLIST_VIEWED: 'PLATFORM_WAITLIST_VIEWED',
  WAITLIST_ENTRY_SUPPRESSED: 'PLATFORM_WAITLIST_ENTRY_SUPPRESSED',
  WAITLIST_PHONE_SET: 'PLATFORM_WAITLIST_PHONE_SET',
  WAITLIST_PHONE_CLEARED: 'PLATFORM_WAITLIST_PHONE_CLEARED',
  REAUTH_FAILED: 'PLATFORM_REAUTH_FAILED',
  ACCESS_DENIED: 'PLATFORM_ACCESS_DENIED',
} as const;

export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[keyof typeof PLATFORM_AUDIT_ACTIONS];

type PlatformAuditMetadata =
  | { action: 'PLATFORM_WAITLIST_VIEWED'; metadata: { activeCount: number } }
  | { action: 'PLATFORM_WAITLIST_ENTRY_SUPPRESSED'; metadata: Record<string, never> }
  | { action: 'PLATFORM_WAITLIST_PHONE_SET'; metadata: { source: 'cli' } }
  | { action: 'PLATFORM_WAITLIST_PHONE_CLEARED'; metadata: { source: 'cli' | 'panel' } }
  | { action: 'PLATFORM_REAUTH_FAILED'; metadata: { operation: 'waitlist-delete' | 'waitlist-phone-delete' } }
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
