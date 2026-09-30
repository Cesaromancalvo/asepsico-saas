/**
 * Utilidades de los tests de importación. Datos 100 % ficticios (dominios example.test).
 *
 * Mock de Prisma con almacén en memoria:
 *  - `update`/`delete` "de uno" lanzan: las escrituras deben ser updateMany/deleteMany acotadas.
 *  - `$transaction` ejecuta el callback con el MISMO mock y, si lanza, restaura la instantánea
 *    previa de todos los almacenes (simula el ROLLBACK), auditoría incluida.
 *  - `failOn` permite hacer fallar la N-ésima llamada a una operación (fallo a mitad de bloque).
 *  - Entiende los filtros que usa la importación: some/none/every/is sobre relaciones del
 *    paciente, in/notIn/not/lte/gte, e `{ increment }` en updateMany.
 */
import { PatientImportAccess } from '../src/patient-import/patient-import-access';
import { PatientImportJobsService } from '../src/patient-import/patient-import-jobs.service';
import { PatientImportService } from '../src/patient-import/patient-import.service';
import { PatientImportConfirmService } from '../src/patient-import/patient-import-confirm.service';
import { PatientImportRevertService } from '../src/patient-import/patient-import-revert.service';

type Row = Record<string, any>;
type Stores = Record<string, Row[]>;

const PATIENT_RELATIONS: Record<string, string> = {
  clinicalProcesses: 'clinicalProcess',
  sessions: 'session',
  therapeuticTasks: 'therapeuticTask',
  therapyGoals: 'therapyGoal',
  clinicalAssessments: 'clinicalAssessment',
  clinicalHistory: 'clinicalHistory',
  patientDocuments: 'patientDocument',
  consentRecords: 'consentRecord',
  clinicalReports: 'clinicalReport',
  invoices: 'invoice',
  payments: 'payment',
  portalAccounts: 'patientPortalAccount',
  resourceShares: 'resourceShare',
  conversations: 'conversation',
};

const DEFAULTS: Record<string, Row> = {
  patient: { status: 'ACTIVE', portalAccessMode: 'PATIENT_ONLY', email: null, phone: null, birthDate: null, consultationReason: null },
  clinicalProcess: { status: 'ACTIVE', consultationReason: null, goals: null, internalNotes: null, frequency: null, modality: 'IN_PERSON' },
  patientImportJob: {
    status: 'UPLOADED', payload: null, payloadExpiresAt: null, mapping: null, plan: null, errorReport: null, totalRows: 0, cursor: 0,
    createdCount: 0, completedCount: 0, skippedCount: 0, errorCount: 0, revertedCount: 0, confirmedAt: null, finishedAt: null,
    revertibleUntil: null, revertedAt: null,
  },
};

export const STORE_NAMES = [
  'patient', 'clinicalProcess', 'session', 'therapeuticTask', 'therapyGoal', 'clinicalAssessment', 'clinicalHistory',
  'patientDocument', 'consentRecord', 'clinicalReport', 'invoice', 'payment', 'patientPortalAccount', 'resourceShare',
  'conversation', 'notification', 'auditLog', 'patientImportJob', 'patientImportItem', 'workspaceMember',
];

export function prismaMock(seed: Partial<Stores> = {}) {
  const db: { stores: Stores } = {
    stores: Object.fromEntries(STORE_NAMES.map((name) => [name, (seed[name] ?? []).map((r) => ({ ...r }))])),
  };
  const clone = (s: Stores): Stores => Object.fromEntries(Object.entries(s).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  const failOn: { model?: string; op?: string; nth?: number; calls: number } = { calls: 0 };

  const matchValue = (value: any, filter: any): boolean => {
    if (filter === null) return (value ?? null) === null;
    if (filter instanceof Date) return value instanceof Date && value.getTime() === filter.getTime();
    if (typeof filter !== 'object') return value === filter;
    return Object.entries(filter).every(([op, arg]: [string, any]) => {
      switch (op) {
        case 'in': return arg.includes(value);
        case 'notIn': return !arg.includes(value);
        case 'not': return arg === null ? (value ?? null) !== null : !matchValue(value, arg);
        case 'lte': return value !== null && value !== undefined && value <= arg;
        case 'lt': return value !== null && value !== undefined && value < arg;
        case 'gte': return value !== null && value !== undefined && value >= arg;
        case 'gt': return value !== null && value !== undefined && value > arg;
        default: return true;
      }
    });
  };

  const matches = (model: string, row: Row, where: any = {}): boolean =>
    Object.entries(where ?? {}).every(([key, filter]: [string, any]) => {
      if (model === 'patient' && PATIENT_RELATIONS[key]) {
        const related = db.stores[PATIENT_RELATIONS[key]].filter((r) => r.patientId === row.id);
        const relModel = PATIENT_RELATIONS[key];
        if (filter === null) return related.length === 0;
        if ('is' in filter) return filter.is === null ? related.length === 0 : related.some((r) => matches(relModel, r, filter.is));
        if ('some' in filter) return related.some((r) => matches(relModel, r, filter.some));
        if ('none' in filter) return !related.some((r) => matches(relModel, r, filter.none));
        if ('every' in filter) return related.every((r) => matches(relModel, r, filter.every));
        return true;
      }
      if (model === 'patientImportItem' && key === 'job') {
        const job = db.stores.patientImportJob.find((j) => j.id === row.jobId);
        return Boolean(job) && matches('patientImportJob', job!, filter);
      }
      return matchValue(row[key], filter);
    });

  const maybeFail = (model: string, op: string) => {
    if (failOn.model === model && failOn.op === op) {
      failOn.calls += 1;
      if (failOn.calls === failOn.nth) throw Object.assign(new Error('fallo simulado'), { code: 'P2034' });
    }
  };

  let seq = 0;
  const model = (name: string) => ({
    findFirst: jest.fn(async ({ where }: any = {}) => {
      const found = db.stores[name].find((r) => matches(name, r, where));
      return found ? { ...found } : null;
    }),
    findMany: jest.fn(async ({ where }: any = {}) => db.stores[name].filter((r) => matches(name, r, where)).map((r) => ({ ...r }))),
    count: jest.fn(async ({ where }: any = {}) => db.stores[name].filter((r) => matches(name, r, where)).length),
    create: jest.fn(async ({ data }: any) => {
      maybeFail(name, 'create');
      const now = new Date();
      const row = { id: `${name}-${++seq}`, createdAt: now, updatedAt: now, ...(DEFAULTS[name] ?? {}), ...data };
      db.stores[name].push(row);
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      db.stores[name] = db.stores[name].map((r) => {
        if (!matches(name, r, where)) return r;
        count += 1;
        const next: Row = { ...r, updatedAt: new Date(Math.max(Date.now(), r.updatedAt?.getTime?.() + 1 || 0)) };
        for (const [key, value] of Object.entries(data)) {
          next[key] = value && typeof value === 'object' && 'increment' in (value as any) ? (r[key] ?? 0) + (value as any).increment : value;
        }
        return next;
      });
      return { count };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const before = db.stores[name].length;
      db.stores[name] = db.stores[name].filter((r) => !matches(name, r, where));
      return { count: before - db.stores[name].length };
    }),
    update: jest.fn(async () => { throw new Error(`${name}.update no debe usarse: la escritura debe filtrar por workspaceId`); }),
    delete: jest.fn(async () => { throw new Error(`${name}.delete no debe usarse: la escritura debe filtrar por workspaceId`); }),
  });

  const prisma: any = Object.fromEntries(STORE_NAMES.map((name) => [name, model(name)]));
  prisma.$transaction = jest.fn(async (fn: any) => {
    const snapshot = clone(db.stores);
    try {
      return await fn(prisma);
    } catch (error) {
      db.stores = snapshot;
      throw error;
    }
  });
  return { prisma, db, failOn };
}

export function services(prisma: any) {
  const access = new PatientImportAccess(prisma);
  const jobs = new PatientImportJobsService(prisma);
  return {
    imports: new PatientImportService(prisma, access, jobs),
    confirm: new PatientImportConfirmService(prisma, access, jobs),
    revert: new PatientImportRevertService(prisma, access, jobs),
    jobs,
  };
}

export const actor = (sub: string, role: string, workspaceId = 'ws-1') => ({ sub, workspaceId, role, email: `${sub}@example.test` });

export const csvFile = (text: string, name = 'pacientes.csv') => {
  const buffer = Buffer.from(text, 'utf8');
  return { buffer, size: buffer.length, originalname: name };
};

/** CSV ficticio con n pacientes (Paciente001 Ficticio Prueba, paciente001@example.test…). */
export function fakePatientsCsv(n: number, extraHeader = '', extraCell = ''): string {
  const header = `nombre;apellidos;email;telefono;fecha_nacimiento;estado${extraHeader ? `;${extraHeader}` : ''}`;
  const rows = Array.from({ length: n }, (_, i) => {
    const id = String(i + 1).padStart(3, '0');
    return `Paciente${id};Ficticio Prueba;paciente${id}@example.test;6000${id.padStart(5, '0')};01/02/1980;activo${extraHeader ? `;${extraCell}` : ''}`;
  });
  return [header, ...rows].join('\r\n');
}

export const FULL_MAPPING = [
  { index: 0, field: 'nombre' as const },
  { index: 1, field: 'apellidos' as const },
  { index: 2, field: 'email' as const },
  { index: 3, field: 'telefono' as const },
  { index: 4, field: 'fecha_nacimiento' as const },
  { index: 5, field: 'estado' as const },
];
