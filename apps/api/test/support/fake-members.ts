/**
 * Doble de workspaceMember.findMany para los tests con mocks a mano: filtra por workspaceId,
 * userId/role (igualdad o `in`) y status (sin status en la fila = ACTIVE). Datos ficticios.
 */
type Member = { workspaceId: string; userId: string; role: string; status?: string };

export function fakeMembersFindMany(rows: Member[]) {
  const ok = (value: unknown, cond: any) => cond === undefined || (cond && typeof cond === 'object' && 'in' in cond ? cond.in.includes(value) : value === cond);
  return jest.fn(async ({ where = {} }: any = {}) =>
    rows
      .filter((m) => ok(m.workspaceId, where.workspaceId) && ok(m.userId, where.userId) && ok(m.role, where.role) && ok(m.status ?? 'ACTIVE', where.status))
      .map((m) => ({ userId: m.userId })));
}

export const FAKE_TEAM: Member[] = [
  { workspaceId: 'w1', userId: 'o1', role: 'OWNER' },
  { workspaceId: 'w1', userId: 'ad1', role: 'ADMIN' },
  { workspaceId: 'w1', userId: 't1', role: 'THERAPIST' },
  { workspaceId: 'w1', userId: 'a1', role: 'ASSISTANT' },
  { workspaceId: 'w2', userId: 'o2', role: 'OWNER' },
];
