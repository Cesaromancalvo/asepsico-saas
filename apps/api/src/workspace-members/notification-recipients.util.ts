type RecipientsDb = {
  workspaceMember: {
    findMany(args: { where: Record<string, unknown>; select: { userId: true } }): Promise<{ userId: string }[]>;
  };
};

/**
 * Destinatarios reales de un aviso dirigido a profesionales (historia B, condición de Argos).
 * Un miembro ACTIVE lo recibe él mismo. Si ya no es miembro activo (dado de baja con "decidir
 * después"), el aviso va a los OWNER/ADMIN activos del espacio, para que nada se pierda.
 * Siempre acotado al workspace. Devuelve, por cada userId pedido, a quién se envía.
 */
export async function routeToActiveMembers(db: RecipientsDb, workspaceId: string, userIds: string[]): Promise<Map<string, string[]>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const routes = new Map<string, string[]>();
  if (!unique.length) return routes;
  const active = await db.workspaceMember.findMany({ where: { workspaceId, userId: { in: unique }, status: 'ACTIVE' }, select: { userId: true } });
  const activeIds = new Set(active.map((m) => m.userId));
  const missing = unique.filter((id) => !activeIds.has(id));
  const admins = missing.length
    ? (await db.workspaceMember.findMany({ where: { workspaceId, role: { in: ['OWNER', 'ADMIN'] }, status: 'ACTIVE' }, select: { userId: true } })).map((m) => m.userId)
    : [];
  for (const id of unique) routes.set(id, activeIds.has(id) ? [id] : admins);
  return routes;
}
