/**
 * Utilidades de test para el acceso clínico (ClinicalAccessService). Datos 100 % ficticios.
 *
 * `withClinicalAccess(prisma, fixture)` instala en un doble de Prisma:
 *  - workspaceMember.findFirst → busca el miembro por { workspaceId, userId } en `members`;
 *  - clinicalProcess.findMany  → filtra `processes` por igualdad simple de los campos del where
 *    (workspaceId, patientId, therapistId, status...). Si el test ya tenía un findMany propio, se
 *    usa para las llamadas que no son del servicio de acceso;
 *  - auditLog.create (si no existía) para registrar las denegaciones.
 */

export type FakeMember = { userId: string; role: string; isClinician: boolean; workspaceId?: string };
export type FakeProcess = {
  id: string; patientId: string; therapistId: string; status: string; workspaceId?: string;
  createdAt?: Date; endedAt?: Date | null; updatedAt?: Date;
};

export function matchesWhere(row: Record<string, any>, where: Record<string, any> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === 'OR') return (condition as any[]).some((sub) => matchesWhere(row, sub));
    if (key === 'AND') return (condition as any[]).every((sub) => matchesWhere(row, sub));
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('in' in condition) return (condition.in as unknown[]).includes(value);
      if ('not' in condition) return condition.not && typeof condition.not === 'object' && 'in' in condition.not
        ? !(condition.not.in as unknown[]).includes(value) : value !== condition.not;
      if ('notIn' in condition) return !(condition.notIn as unknown[]).includes(value);
      if ('contains' in condition) {
        if (typeof value !== 'string') return false;
        return condition.mode === 'insensitive'
          ? value.toLowerCase().includes(String(condition.contains).toLowerCase())
          : value.includes(String(condition.contains));
      }
      if ('gte' in condition || 'lte' in condition || 'gt' in condition || 'lt' in condition) {
        const time = new Date(value).getTime();
        if (condition.gte !== undefined && !(time >= new Date(condition.gte).getTime())) return false;
        if (condition.lte !== undefined && !(time <= new Date(condition.lte).getTime())) return false;
        if (condition.gt !== undefined && !(time > new Date(condition.gt).getTime())) return false;
        if (condition.lt !== undefined && !(time < new Date(condition.lt).getTime())) return false;
        return true;
      }
      // Filtro por relación (p. ej. patient: { workspaceId }): si la fila trae la relación, se
      // comprueba; relación nula → no coincide (como Prisma); si el doble no la modela
      // (undefined), se ignora.
      if (value === null) return false;
      if (value && typeof value === 'object') return matchesWhere(value, condition);
      return true;
    }
    return value === condition;
  });
}

const DEFAULT_DATE = new Date('2026-01-01T00:00:00Z');

export function withClinicalAccess<T extends Record<string, any>>(prisma: T, fixture: { members: FakeMember[]; processes?: FakeProcess[]; workspaceId?: string }): T {
  const ws = fixture.workspaceId ?? 'ws-1';
  const members = fixture.members.map((member) => ({ workspaceId: ws, ...member }));
  const processes = (fixture.processes ?? []).map((process) => ({
    workspaceId: ws, createdAt: DEFAULT_DATE, endedAt: null, updatedAt: DEFAULT_DATE, ...process,
  }));
  const target: any = prisma;
  target.workspaceMember = target.workspaceMember ?? {};
  const previousMemberFindFirst = target.workspaceMember.findFirst;
  target.workspaceMember.findFirst = jest.fn(async (args: any) => {
    const where = args?.where ?? {};
    // Llamadas del servicio de acceso: { workspaceId, userId } con select de role/isClinician.
    if (args?.select?.isClinician || !previousMemberFindFirst) {
      return members.find((member) => matchesWhere(member, where)) ?? null;
    }
    return previousMemberFindFirst(args);
  });
  target.clinicalProcess = target.clinicalProcess ?? {};
  const previousFindMany = target.clinicalProcess.findMany;
  target.clinicalProcess.findMany = jest.fn(async (args: any) => {
    // Consultas propias de ClinicalAccessService (decide / listingContext), por su select exacto.
    const keys = args?.select ? Object.keys(args.select).sort().join() : '';
    const isAccessQuery = keys === 'createdAt,endedAt,id,pausedAt,status,updatedAt' || keys === 'patientId';
    if (isAccessQuery || !previousFindMany) return processes.filter((process) => matchesWhere(process, args?.where));
    return previousFindMany(args);
  });
  target.auditLog = target.auditLog ?? {};
  target.auditLog.create = target.auditLog.create ?? jest.fn(async () => ({}));
  return prisma;
}

/** Acceso de tratamiento listo: el actor es clínico y tiene un proceso ACTIVO con el paciente. */
export function treating<T extends Record<string, any>>(prisma: T, actor: { sub: string; role: string; workspaceId?: string }, patientId = 'patient-1'): T {
  return withClinicalAccess(prisma, {
    workspaceId: actor.workspaceId ?? 'ws-1',
    members: [{ userId: actor.sub, role: actor.role, isClinician: actor.role !== 'ASSISTANT' }],
    processes: actor.role === 'ASSISTANT' ? [] : [{ id: `proc-${actor.sub}`, patientId, therapistId: actor.sub, status: 'ACTIVE' }],
  });
}

/**
 * Doble del servicio de acceso que concede TREATING (para tests que prueban otra cosa: cifrado,
 * escrituras acotadas...). La decisión real se prueba en clinical-access-matrix.security-spec.ts.
 */
export function treatingAccessStub(patient: Record<string, any> = { id: 'patient-1', status: 'ACTIVE' }, actorId = 'owner-1') {
  const scope = {
    level: 'TREATING' as const, actorId, ownProcessIds: ['proc-1'], activeProcessIds: ['proc-1'],
    processWindows: [{ from: new Date(0), to: null }],
  };
  return {
    assertPatientClinicalAccess: jest.fn(async () => patient),
    assertTreating: jest.fn(async () => ({ patient, scope })),
    assertCanRead: jest.fn(async () => ({ patient, scope })),
    assertClinician: jest.fn(async () => undefined),
    resolveScope: jest.fn(async () => scope),
    getMemberProfile: jest.fn(async () => ({ role: 'OWNER', isClinician: true })),
    isClinician: jest.fn(async () => true),
    listingContext: jest.fn(async () => ({ isClinician: true, treatingPatientIds: new Set([patient.id]) })),
    treatingPatientIds: jest.fn(async () => new Set([patient.id])),
    auditDenied: jest.fn(async () => undefined),
  };
}
