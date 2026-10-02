import { Prisma } from '@prisma/client';

/**
 * BD en memoria para registro por invitación, invitaciones de miembros y aceptación de
 * condiciones. Emula lo que importa para la seguridad: `where` con igualdad/null/gt/in/OR y la
 * relación user.email, unicidad (P2002), los CHECK de rol/isClinician y el rollback de
 * $transaction. Datos 100 % ficticios.
 */
type Row = Record<string, any>;

const MODELS = ['user', 'workspace', 'workspaceMember', 'registrationInvite', 'workspaceInvite', 'termsAcceptance', 'auditLog', 'refreshToken'] as const;
const UNIQUE: Record<string, string[][]> = {
  user: [['email']],
  registrationInvite: [['tokenHash']],
  workspaceInvite: [['tokenHash']],
  workspaceMember: [['workspaceId', 'userId']],
  termsAcceptance: [['workspaceId', 'userId', 'documentType', 'version', 'textHash']],
};

let seq = 0;

function p2002(model: string) {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${model}`, { code: 'P2002', clientVersion: 'test' });
}

function checkConstraints(model: string, row: Row) {
  if (model === 'workspaceMember' || model === 'workspaceInvite') {
    if (row.role === 'ASSISTANT' && row.isClinician) throw new Error(`CHECK ${model}_assistant_not_clinician`);
    if (row.role === 'THERAPIST' && !row.isClinician) throw new Error(`CHECK ${model}_therapist_is_clinician`);
  }
  if (model === 'workspaceInvite' && row.role === 'OWNER') throw new Error('CHECK WorkspaceInvite_not_owner');
}

export function fakeRegistrationDb(seed: Partial<Record<(typeof MODELS)[number], Row[]>> = {}) {
  let store: Record<string, Row[]> = Object.fromEntries(MODELS.map((m) => [m, (seed[m] ?? []).map((r) => ({ ...r }))]));

  const matches = (model: string, row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (key === 'OR') return (cond as Row[]).some((w) => matches(model, row, w));
      if (key === 'AND') return (cond as Row[]).every((w) => matches(model, row, w));
      if (key === 'user' && model === 'workspaceMember') {
        const user = store.user.find((u) => u.id === row.userId);
        return !!user && matches('user', user, cond);
      }
      const value = row[key];
      if (cond === null) return value === null || value === undefined;
      if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
      if (typeof cond === 'object') {
        if ('gt' in cond) return value instanceof Date ? value > cond.gt : value > cond.gt;
        if ('in' in cond) return cond.in.includes(value);
        if ('not' in cond) return value !== cond.not;
      }
      return value === cond;
    });
  };

  const assertUnique = (model: string, row: Row, ignoreId?: string) => {
    for (const keys of UNIQUE[model] ?? []) {
      if (store[model].some((r) => r.id !== ignoreId && keys.every((k) => r[k] !== undefined && r[k] !== null && r[k] === row[k]))) throw p2002(model);
    }
  };

  /** Respeta `select` (como Prisma): así los tests ven exactamente lo que devuelve la API. */
  const project = (row: Row, select?: Row): Row =>
    select ? Object.fromEntries(Object.entries(select).filter(([, v]) => v).map(([k]) => [k, row[k] ?? null])) : { ...row };

  const delegate = (model: string) => ({
    findUnique: jest.fn(async ({ where, select }: Row) => { const r = store[model].find((x) => matches(model, x, where)); return r ? project(r, select) : null; }),
    findFirst: jest.fn(async ({ where, select }: Row = {}) => { const r = store[model].find((x) => matches(model, x, where)); return r ? project(r, select) : null; }),
    findMany: jest.fn(async ({ where, select }: Row = {}) => store[model].filter((r) => matches(model, r, where)).map((r) => project(r, select))),
    create: jest.fn(async ({ data, select }: Row) => {
      const row = { id: `${model}-${++seq}`, createdAt: new Date(), ...data };
      if (model === 'termsAcceptance' && !row.acceptedAt) row.acceptedAt = new Date();
      // Defaults de la BD que importan para la seguridad.
      if (model === 'user') Object.assign(row, { totpEnabled: false, mfaFailedAttempts: 0, ...data });
      checkConstraints(model, row);
      assertUnique(model, row);
      store[model].push(row);
      return project(row, select);
    }),
    createMany: jest.fn(async ({ data }: Row) => {
      for (const d of data) await delegate(model).create({ data: d });
      return { count: data.length };
    }),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      const rows = store[model].filter((r) => matches(model, r, where));
      for (const r of rows) {
        const next = { ...r, ...data };
        checkConstraints(model, next);
        assertUnique(model, next, r.id);
        Object.assign(r, data);
      }
      return { count: rows.length };
    }),
  });

  const prisma: any = Object.fromEntries(MODELS.map((m) => [m, delegate(m)]));
  prisma.$transaction = jest.fn(async (cb: (tx: any) => Promise<unknown>) => {
    const snapshot = Object.fromEntries(Object.entries(store).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
    try {
      return await cb(prisma);
    } catch (error) {
      store = snapshot;
      throw error;
    }
  });
  Object.defineProperty(prisma, '__store', { get: () => store });
  return prisma;
}
