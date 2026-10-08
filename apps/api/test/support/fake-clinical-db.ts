import { matchesWhere } from './clinical-access-fixture';

/**
 * Base de datos en memoria para la matriz de acceso clínico. Aplica los `where` (igualdad, in,
 * not, rangos de fecha, OR/AND y filtros por relación) y resuelve las relaciones que usan los
 * servicios. Ignora `select` (devuelve la fila completa: peor caso), así que las respuestas se
 * comprueban por su contenido real. Datos 100 % ficticios.
 */

type Row = Record<string, any>;
export type Store = Record<string, Row[]>;

const CHILD_RELATIONS: Record<string, string> = {
  clinicalProcesses: 'clinicalProcess', sessions: 'session', therapyGoals: 'therapyGoal', therapeuticTasks: 'therapeuticTask',
  clinicalAssessments: 'clinicalAssessment', consentRecords: 'consentRecord', clinicalReports: 'clinicalReport',
  patientDocuments: 'patientDocument', resourceShares: 'resourceShare', invoices: 'invoice',
};

export function fakeClinicalDb(seed: Partial<Store>) {
  const store: Store = {
    patient: [], workspaceMember: [], clinicalProcess: [], session: [], clinicalHistory: [], therapyGoal: [],
    therapeuticTask: [], clinicalAssessment: [], patientDocument: [], consentRecord: [], clinicalReport: [],
    conversation: [], message: [], auditLog: [], resourceShare: [], invoice: [], notification: [], user: [],
    ...seed,
  } as Store;

  const byId = (model: string, id: unknown) => store[model].find((row) => row.id === id);
  const minimal = (row: Row | undefined) => (row ? {
    id: row.id, workspaceId: row.workspaceId, therapistId: row.therapistId, patientId: row.patientId,
    firstName: row.firstName, lastName: row.lastName,
  } : null);
  /** Relación con `{ select }`: solo esas claves (como Prisma); `true`/include: la fila completa. */
  const project = (related: Row | null | undefined, rule: any): Row | null => {
    if (!related) return related ?? null;
    if (rule && typeof rule === 'object' && rule.select) {
      return Object.fromEntries(Object.entries(rule.select).filter(([, v]) => v).map(([k]) => [k, related[k]]));
    }
    return related;
  };

  /** Relaciones mínimas para poder filtrar por ellas (patient: { workspaceId }, session: {...}). */
  const withRelationsForMatching = (model: string, row: Row): Row => {
    const out: Row = { ...row };
    if ('patientId' in row && model !== 'patient') out.patient = minimal(byId('patient', row.patientId));
    if (model === 'therapeuticTask') out.session = row.sessionId ? minimal(byId('session', row.sessionId)) : null;
    if (model === 'message') out.conversation = minimal(byId('conversation', row.conversationId));
    return out;
  };

  /** Relaciones que devuelven los include/select de los servicios (filas completas: peor caso). */
  const hydrate = (model: string, row: Row, args: Row = {}): Row => {
    const spec = { ...(args.include ?? {}), ...(args.select ?? {}) };
    const out: Row = { ...row };
    if (model === 'patient') {
      for (const [key, child] of Object.entries(CHILD_RELATIONS)) {
        if (!spec[key]) continue;
        const where = typeof spec[key] === 'object' ? spec[key].where : undefined;
        out[key] = store[child].filter((c) => c.patientId === row.id).map((c) => withRelationsForMatching(child, c)).filter((c) => matchesWhere(c, where)).map(strip);
      }
      if (spec.clinicalHistory) out.clinicalHistory = store.clinicalHistory.find((h) => h.patientId === row.id) ?? null;
    }
    if (spec.patient && row.patientId) out.patient = project(byId('patient', row.patientId), spec.patient);
    if (spec.therapist && row.therapistId) out.therapist = { id: row.therapistId, firstName: 'Profesional', lastName: 'Ficticio' };
    if (model === 'clinicalProcess' && spec.sessions) {
      const where = typeof spec.sessions === 'object' ? spec.sessions.where : undefined;
      out.sessions = store.session.filter((s) => s.clinicalProcessId === row.id && matchesWhere(s, where));
    }
    if (model === 'session' && spec.clinicalProcess) out.clinicalProcess = row.clinicalProcessId ? project(byId('clinicalProcess', row.clinicalProcessId), spec.clinicalProcess) : null;
    if (model === 'therapeuticTask') {
      if (spec.session) out.session = row.sessionId ? { id: row.sessionId } : null;
      if (spec.therapyGoal) out.therapyGoal = row.therapyGoalId ? project(byId('therapyGoal', row.therapyGoalId), spec.therapyGoal) : null;
    }
    if (model === 'conversation' && spec.messages) out.messages = [];
    if (spec._count) out._count = { sessions: 0, clinicalProcesses: 0, messages: 0 };
    return out;
  };

  const strip = (row: Row) => {
    const { patient: _p, session: _s, conversation: _c, ...rest } = row;
    return { ...rest, ...(row.sessionId !== undefined ? {} : {}) };
  };

  const find = (model: string, where: Row | undefined) =>
    store[model].filter((row) => matchesWhere(withRelationsForMatching(model, row), where));

  const model = (name: string) => ({
    findFirst: jest.fn(async (args: Row = {}) => {
      const row = find(name, args.where)[0];
      return row ? hydrate(name, row, args) : null;
    }),
    findUnique: jest.fn(async (args: Row = {}) => {
      const row = find(name, args.where)[0];
      return row ? hydrate(name, row, args) : null;
    }),
    findMany: jest.fn(async (args: Row = {}) => {
      let rows = find(name, args.where);
      const order = Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy;
      const key = order && Object.keys(order)[0];
      if (key && typeof order[key] === 'string') {
        rows = [...rows].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (order[key] === 'desc' ? -1 : 1));
      }
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map((row) => hydrate(name, row, args));
    }),
    count: jest.fn(async (args: Row = {}) => find(name, args.where).length),
    create: jest.fn(async ({ data }: Row) => {
      const row = { id: `${name}-${store[name].length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      store[name].push(row);
      return { ...row };
    }),
    createMany: jest.fn(async ({ data }: Row) => { store[name].push(...(Array.isArray(data) ? data : [data])); return { count: 1 }; }),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      const rows = find(name, where);
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    }),
    deleteMany: jest.fn(async ({ where }: Row) => {
      const rows = new Set(find(name, where));
      store[name] = store[name].filter((row) => !rows.has(row));
      return { count: rows.size };
    }),
    update: jest.fn(async () => { throw new Error(`${name}.update no debe usarse`); }),
    upsert: jest.fn(async () => { throw new Error(`${name}.upsert no se modela en la matriz`); }),
  });

  const prisma: any = {};
  for (const name of Object.keys(store)) prisma[name] = model(name);
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  prisma.__store = store;
  return prisma;
}
