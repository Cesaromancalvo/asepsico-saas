import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Borrado de invitaciones de registro que ya no sirven (Argos 23/11/2026, punto 3).
 *
 * Una invitación SIN USAR que ha caducado o se ha revocado (p. ej. al reinvitar al mismo correo) solo
 * guarda el correo de alguien que no llegó a registrarse: se borra. Las usadas NUNCA se tocan (son la
 * prueba de cómo se creó cada espacio y cuelgan de User y Workspace), ni las vigentes.
 *
 * Las invitaciones de registro son de plataforma (aún no tienen espacio): no hay workspaceId que
 * filtrar. Por eso el filtro exige además workspaceId y usedByUserId nulos, aunque usedAt IS NULL ya
 * lo implica: si alguna fila estuviera incoherente, se queda.
 *
 * Solo devuelve recuentos: nunca correos ni ids.
 */
const UNUSED = { usedAt: null, usedByUserId: null, workspaceId: null } as const;

export function staleRegistrationInviteWhere(now: Date): Prisma.RegistrationInviteWhereInput {
  return { ...UNUSED, OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] };
}

export type InvitePurgeResult = {
  /** Sin usar y caducadas (incluye las que además están revocadas). */
  expired: number;
  /** Sin usar, revocadas y aún no caducadas. */
  revoked: number;
  /** expired + revoked: lo que se borra (o se borraría). */
  total: number;
  /** true si se ha borrado; false en simulación. */
  deleted: boolean;
};

type InvitePurgeDb = Pick<PrismaClient, '$transaction'>;

/** El borrado no coincide con el recuento previo: se deshace la transacción. */
export class InvitePurgeMismatch extends Error {
  constructor() {
    super('El número de invitaciones borradas no coincide con el recuento: no se ha borrado nada.');
  }
}

/**
 * Cuenta y, solo con `apply: true`, borra en UNA transacción. Si el DELETE no coincide con el recuento
 * hecho dentro de la misma transacción, lanza y no se borra nada (igual que el SQL manual de Argos).
 */
export async function purgeStaleRegistrationInvites(
  prisma: InvitePurgeDb,
  options: { apply?: boolean; now?: Date } = {},
): Promise<InvitePurgeResult> {
  const now = options.now ?? new Date();
  const where = staleRegistrationInviteWhere(now);
  return prisma.$transaction(async (tx) => {
    const total = await tx.registrationInvite.count({ where });
    const expired = await tx.registrationInvite.count({ where: { ...UNUSED, expiresAt: { lt: now } } });
    const result = { expired, revoked: total - expired, total, deleted: false };
    if (!options.apply || total === 0) return result;
    const { count } = await tx.registrationInvite.deleteMany({ where });
    if (count !== total) throw new InvitePurgeMismatch();
    return { ...result, deleted: true };
  });
}
