import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PatientsService } from '../src/patients/patients.service';
import { PortalService } from '../src/portal/portal.service';

// Datos 100 % ficticios.
const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER', email: 'o@example.com' } as any;
const assistant = { sub: 'assistant-1', workspaceId: 'ws-1', role: 'ASSISTANT', email: 'a@example.com' } as any;

type Row = Record<string, any>;
type Stores = Record<string, Row[]>;

/**
 * Mock de Prisma con almacén en memoria para todos los modelos que tocan patients/ y portal/.
 *  - update/delete/upsert "de uno" lanzan: las escrituras deben ser updateMany/deleteMany
 *    acotadas (id + workspaceId, o id + patientId + patient.workspaceId).
 *  - $transaction ejecuta el callback con el MISMO mock y, si lanza, restaura la instantánea
 *    previa de todos los almacenes (simula el ROLLBACK), auditoría incluida.
 *  - __beforeTx permite simular otra petición que cambia el registro entre la validación
 *    previa y la escritura (carrera).
 */
function prismaMock(seed: Partial<Stores> = {}) {
  let stores: Stores = {
    patient: [
      { id: 'patient-1', workspaceId: 'ws-1', status: 'ACTIVE', deletedAt: null, firstName: 'Paciente', lastName: 'Ficticio' },
      { id: 'patient-ws2', workspaceId: 'ws-2', status: 'ACTIVE', deletedAt: null, firstName: 'Otro', lastName: 'Ficticio' },
    ],
    clinicalProcess: [{ id: 'proc-1', workspaceId: 'ws-1', patientId: 'patient-1', therapistId: 'therapist-1' }],
    therapeuticTaskTemplate: [], therapeuticTask: [], therapyGoal: [], clinicalAssessment: [], clinicalHistory: [],
    patientDocument: [], consentRecord: [], clinicalReport: [], patientPortalAccount: [], auditLog: [], notification: [],
    session: [], invoice: [], resourceShare: [],
    ...seed,
  } as Stores;
  const clone = (s: Stores): Stores => Object.fromEntries(Object.entries(s).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  stores = clone(stores);

  const matchValue = (value: any, filter: any): boolean => {
    if (filter === null) return (value ?? null) === null;
    if (filter instanceof Date) return value instanceof Date && value.getTime() === filter.getTime();
    if (typeof filter !== 'object') return value === filter;
    if ('in' in filter) return filter.in.includes(value);
    if ('notIn' in filter) return !filter.notIn.includes(value);
    if ('not' in filter) return value !== filter.not;
    if ('gte' in filter) return true;
    return true;
  };
  const matches = (row: Row, where: any = {}): boolean =>
    Object.entries(where).every(([key, filter]) => {
      if (key === 'patient') {
        const p = stores.patient.find((x) => x.id === row.patientId);
        return Boolean(p) && matches(p!, filter);
      }
      if (key === 'resource') return true;
      return matchValue(row[key], filter);
    });

  let seq = 0;
  const model = (name: string) => ({
    findFirst: jest.fn(async ({ where }: any = {}) => {
      const found = stores[name].find((r) => matches(r, where));
      return found ? { ...found } : null;
    }),
    findUnique: jest.fn(async ({ where }: any) => {
      const found = stores[name].find((r) => matches(r, where));
      return found ? { ...found } : null;
    }),
    findMany: jest.fn(async ({ where }: any = {}) => stores[name].filter((r) => matches(r, where)).map((r) => ({ ...r }))),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: `${name}-new-${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      stores[name].push(row);
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      stores[name] = stores[name].map((r) => {
        if (!matches(r, where)) return r;
        count += 1;
        return { ...r, ...data, updatedAt: new Date() };
      });
      return { count };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const before = stores[name].length;
      stores[name] = stores[name].filter((r) => !matches(r, where));
      return { count: before - stores[name].length };
    }),
    update: jest.fn(async () => { throw new Error(`${name}.update no debe usarse: la escritura debe filtrar por workspaceId`); }),
    delete: jest.fn(async () => { throw new Error(`${name}.delete no debe usarse: la escritura debe filtrar por workspaceId`); }),
    upsert: jest.fn(async () => { throw new Error(`${name}.upsert no debe usarse: la escritura debe filtrar por workspaceId`); }),
  });

  const prisma: any = {};
  for (const name of Object.keys(stores)) prisma[name] = model(name);
  prisma.__beforeTx = null as null | ((s: Stores) => void);
  prisma.__rows = (name: string) => stores[name];
  prisma.$transaction = jest.fn(async (cb: any) => {
    if (prisma.__beforeTx) prisma.__beforeTx(stores);
    const snapshot = clone(stores);
    try {
      return await cb(prisma);
    } catch (error) {
      stores = snapshot;
      throw error;
    }
  });
  return prisma;
}

const writesOf = (prisma: any, model: string) => [
  ...prisma[model].updateMany.mock.calls,
  ...prisma[model].deleteMany.mock.calls,
  ...prisma[model].update.mock.calls,
  ...prisma[model].delete.mock.calls,
  ...prisma[model].upsert.mock.calls,
];

// ---------------------------------------------------------------------------------------------
// Escrituras del profesional (patients/)
// ---------------------------------------------------------------------------------------------

type Case = {
  name: string;
  model: string;
  kind: 'update' | 'delete';
  action: string;
  /** Filas propias (ws-1) y ajenas (ws-2). La primera propia es la que se escribe. */
  rows: Row[];
  foreignId: string;
  /** Mueve el registro a otro workspace / paciente (simula carrera entre validación y escritura). */
  moveAway: (row: Row) => void;
  run: (s: PatientsService, id: string, actor?: any) => Promise<unknown>;
  /** Claves de alcance que deben ir en el where de la escritura. */
  scope: Row;
  /** Cómo reconocer que la fila propia fue escrita. */
  written: (rows: Row[]) => boolean;
};

const childMove = (row: Row) => { row.patientId = 'patient-ws2'; };
const recordMove = (row: Row) => { row.workspaceId = 'ws-2'; row.patientId = 'patient-ws2'; };
const childScope = { patientId: 'patient-1', patient: { workspaceId: 'ws-1' } };
const recordScope = { patientId: 'patient-1', workspaceId: 'ws-1' };

const cases: Case[] = [
  {
    name: 'updateTaskTemplate', model: 'therapeuticTaskTemplate', kind: 'update', action: 'TASK_TEMPLATE_UPDATED',
    rows: [
      { id: 'tpl-1', workspaceId: 'ws-1', title: 'Plantilla', isActive: true },
      { id: 'tpl-ws2', workspaceId: 'ws-2', title: 'Plantilla ajena', isActive: true },
    ],
    foreignId: 'tpl-ws2', moveAway: (r) => { r.workspaceId = 'ws-2'; },
    run: (s, id, actor = owner) => s.updateTaskTemplate('ws-1', actor, id, { title: 'Plantilla renombrada' }),
    scope: { workspaceId: 'ws-1' },
    written: (rows) => rows.find((r) => r.id === 'tpl-1')?.title === 'Plantilla renombrada',
  },
  {
    name: 'updateTherapeuticTask', model: 'therapeuticTask', kind: 'update', action: 'THERAPEUTIC_TASK_UPDATED',
    rows: [
      { id: 'task-1', patientId: 'patient-1', status: 'PENDING', title: 'Tarea' },
      { id: 'task-ws2', patientId: 'patient-ws2', status: 'PENDING', title: 'Tarea ajena' },
    ],
    foreignId: 'task-ws2', moveAway: childMove,
    run: (s, id, actor = owner) => s.updateTherapeuticTask('ws-1', actor, 'patient-1', id, { title: 'Tarea editada' } as any),
    scope: childScope,
    written: (rows) => rows.find((r) => r.id === 'task-1')?.title === 'Tarea editada',
  },
  {
    name: 'deleteTherapeuticTask', model: 'therapeuticTask', kind: 'delete', action: 'THERAPEUTIC_TASK_DRAFT_DELETED',
    rows: [
      { id: 'task-1', patientId: 'patient-1', status: 'DRAFT', title: 'Borrador' },
      { id: 'task-ws2', patientId: 'patient-ws2', status: 'DRAFT', title: 'Borrador ajeno' },
    ],
    foreignId: 'task-ws2', moveAway: childMove,
    run: (s, id, actor = owner) => s.deleteTherapeuticTask('ws-1', actor, 'patient-1', id),
    scope: childScope,
    written: (rows) => !rows.some((r) => r.id === 'task-1'),
  },
  {
    name: 'updateTherapyGoal', model: 'therapyGoal', kind: 'update', action: 'THERAPY_GOAL_UPDATED',
    rows: [
      { id: 'goal-1', patientId: 'patient-1', status: 'ACTIVE', title: 'Objetivo', priority: 2 },
      { id: 'goal-ws2', patientId: 'patient-ws2', status: 'ACTIVE', title: 'Objetivo ajeno', priority: 2 },
    ],
    foreignId: 'goal-ws2', moveAway: childMove,
    run: (s, id, actor = owner) => s.updateTherapyGoal('ws-1', actor, 'patient-1', id, { priority: 1 } as any),
    scope: childScope,
    written: (rows) => rows.find((r) => r.id === 'goal-1')?.priority === 1,
  },
  {
    name: 'deleteTherapyGoal', model: 'therapyGoal', kind: 'delete', action: 'THERAPY_GOAL_DELETED',
    rows: [
      { id: 'goal-1', patientId: 'patient-1', status: 'ACTIVE', title: 'Objetivo' },
      { id: 'goal-ws2', patientId: 'patient-ws2', status: 'ACTIVE', title: 'Objetivo ajeno' },
    ],
    foreignId: 'goal-ws2', moveAway: childMove,
    run: (s, id, actor = owner) => s.deleteTherapyGoal('ws-1', actor, 'patient-1', id),
    scope: childScope,
    written: (rows) => !rows.some((r) => r.id === 'goal-1'),
  },
  {
    name: 'deleteClinicalAssessment', model: 'clinicalAssessment', kind: 'delete', action: 'CLINICAL_ASSESSMENT_DELETED',
    rows: [
      { id: 'as-1', patientId: 'patient-1', scaleCode: 'PHQ9' },
      { id: 'as-ws2', patientId: 'patient-ws2', scaleCode: 'GAD7' },
    ],
    foreignId: 'as-ws2', moveAway: childMove,
    run: (s, id, actor = owner) => s.deleteClinicalAssessment('ws-1', actor, 'patient-1', id),
    scope: childScope,
    written: (rows) => !rows.some((r) => r.id === 'as-1'),
  },
  {
    name: 'deletePatientDocument', model: 'patientDocument', kind: 'delete', action: 'PATIENT_DOCUMENT_DELETED',
    rows: [
      { id: 'doc-1', workspaceId: 'ws-1', patientId: 'patient-1', type: 'OTHER', title: 'Documento' },
      { id: 'doc-ws2', workspaceId: 'ws-2', patientId: 'patient-ws2', type: 'OTHER', title: 'Documento ajeno' },
    ],
    foreignId: 'doc-ws2', moveAway: recordMove,
    run: (s, id, actor = owner) => s.deletePatientDocument('ws-1', actor, 'patient-1', id),
    scope: recordScope,
    written: (rows) => !rows.some((r) => r.id === 'doc-1'),
  },
  {
    name: 'updateConsentRecord', model: 'consentRecord', kind: 'update', action: 'CONSENT_RECORD_UPDATED',
    rows: [
      { id: 'con-1', workspaceId: 'ws-1', patientId: 'patient-1', type: 'TREATMENT', status: 'PENDING', title: 'Consentimiento', signedAt: null },
      { id: 'con-ws2', workspaceId: 'ws-2', patientId: 'patient-ws2', type: 'TREATMENT', status: 'PENDING', title: 'Ajeno', signedAt: null },
    ],
    foreignId: 'con-ws2', moveAway: recordMove,
    run: (s, id, actor = owner) => s.updateConsentRecord('ws-1', actor, 'patient-1', id, { title: 'Consentimiento revisado' } as any),
    scope: recordScope,
    written: (rows) => rows.find((r) => r.id === 'con-1')?.title === 'Consentimiento revisado',
  },
  {
    name: 'deleteConsentRecord', model: 'consentRecord', kind: 'delete', action: 'CONSENT_RECORD_DELETED',
    rows: [
      { id: 'con-1', workspaceId: 'ws-1', patientId: 'patient-1', type: 'TREATMENT', status: 'PENDING', title: 'Consentimiento' },
      { id: 'con-ws2', workspaceId: 'ws-2', patientId: 'patient-ws2', type: 'TREATMENT', status: 'PENDING', title: 'Ajeno' },
    ],
    foreignId: 'con-ws2', moveAway: recordMove,
    run: (s, id, actor = owner) => s.deleteConsentRecord('ws-1', actor, 'patient-1', id),
    scope: recordScope,
    written: (rows) => !rows.some((r) => r.id === 'con-1'),
  },
  {
    name: 'updateClinicalReport', model: 'clinicalReport', kind: 'update', action: 'CLINICAL_REPORT_UPDATED',
    rows: [
      { id: 'rep-1', workspaceId: 'ws-1', patientId: 'patient-1', type: 'EVOLUTION', status: 'DRAFT', title: 'Informe', content: 'x', finalizedAt: null },
      { id: 'rep-ws2', workspaceId: 'ws-2', patientId: 'patient-ws2', type: 'EVOLUTION', status: 'DRAFT', title: 'Ajeno', content: 'x', finalizedAt: null },
    ],
    foreignId: 'rep-ws2', moveAway: recordMove,
    run: (s, id, actor = owner) => s.updateClinicalReport('ws-1', actor, 'patient-1', id, { title: 'Informe revisado' } as any),
    scope: recordScope,
    written: (rows) => rows.find((r) => r.id === 'rep-1')?.title === 'Informe revisado',
  },
  {
    name: 'deleteClinicalReport', model: 'clinicalReport', kind: 'delete', action: 'CLINICAL_REPORT_DELETED',
    rows: [
      { id: 'rep-1', workspaceId: 'ws-1', patientId: 'patient-1', type: 'EVOLUTION', status: 'DRAFT', title: 'Informe' },
      { id: 'rep-ws2', workspaceId: 'ws-2', patientId: 'patient-ws2', type: 'EVOLUTION', status: 'DRAFT', title: 'Ajeno' },
    ],
    foreignId: 'rep-ws2', moveAway: recordMove,
    run: (s, id, actor = owner) => s.deleteClinicalReport('ws-1', actor, 'patient-1', id),
    scope: recordScope,
    written: (rows) => !rows.some((r) => r.id === 'rep-1'),
  },
];

const setup = (c: Case) => {
  const prisma = prismaMock({ [c.model]: c.rows });
  return { prisma, service: new PatientsService(prisma), ownId: c.rows[0].id };
};

describe('Escrituras de patients/ acotadas por workspace y auditadas en la misma transacción', () => {
  describe.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    it('escribe con where { id, ...alcance de workspace } y audita dentro de la transacción', async () => {
      const { prisma, service, ownId } = setup(c);
      await c.run(service, ownId);

      const many = c.kind === 'update' ? prisma[c.model].updateMany : prisma[c.model].deleteMany;
      expect(many).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: ownId, ...c.scope }) }));
      expect(prisma[c.model].update).not.toHaveBeenCalled();
      expect(prisma[c.model].delete).not.toHaveBeenCalled();
      expect(c.written(prisma.__rows(c.model))).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.__rows('auditLog')).toEqual([
        expect.objectContaining({ workspaceId: 'ws-1', actorId: owner.sub, action: c.action, entityId: ownId }),
      ]);
    });

    it('recurso de otro workspace → 404, sin escritura ni auditoría', async () => {
      const { prisma, service } = setup(c);
      await expect(c.run(service, c.foreignId)).rejects.toBeInstanceOf(NotFoundException);
      expect(writesOf(prisma, c.model)).toHaveLength(0);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(prisma.__rows(c.model)).toEqual(c.rows);
    });

    it('si el recurso sale del workspace entre la validación y la escritura → 404 y nada confirmado', async () => {
      const { prisma, service, ownId } = setup(c);
      prisma.__beforeTx = (stores: Stores) => c.moveAway(stores[c.model].find((r) => r.id === ownId)!);
      await expect(c.run(service, ownId)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.__rows('auditLog')).toHaveLength(0);
      const moved = prisma.__rows(c.model).find((r: Row) => r.id === ownId);
      expect(moved).toBeDefined();
      expect(c.written(prisma.__rows(c.model))).toBe(false);
    });

    it('si auditLog.create falla, el error se propaga y la escritura no se confirma', async () => {
      const { prisma, service, ownId } = setup(c);
      prisma.auditLog.create.mockRejectedValueOnce(new Error('auditoría caída'));
      await expect(c.run(service, ownId)).rejects.toThrow('auditoría caída');
      expect(c.written(prisma.__rows(c.model))).toBe(false);
      expect(prisma.__rows('auditLog')).toHaveLength(0);
    });

    it('ASSISTANT no accede: 403 sin escrituras ni auditoría', async () => {
      const { prisma, service, ownId } = setup(c);
      await expect(c.run(service, ownId, assistant)).rejects.toBeInstanceOf(ForbiddenException);
      expect(writesOf(prisma, c.model)).toHaveLength(0);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  it('updateTaskTemplate audita solo nombres de campo, sin contenido de la plantilla', async () => {
    const prisma = prismaMock({ therapeuticTaskTemplate: [{ id: 'tpl-1', workspaceId: 'ws-1', title: 'Plantilla', isActive: true }] });
    await new PatientsService(prisma).updateTaskTemplate('ws-1', owner, 'tpl-1', { title: 'Registro de pensamientos', instructions: 'Texto sensible ficticio' });
    const [audit] = prisma.__rows('auditLog');
    expect(audit).toEqual(expect.objectContaining({ entityType: 'TherapeuticTaskTemplate', metadata: { updatedFields: ['title', 'instructions'] } }));
    expect(JSON.stringify(audit)).not.toContain('Registro de pensamientos');
    expect(JSON.stringify(audit)).not.toContain('Texto sensible');
  });

  it('createTaskTemplate: si la auditoría falla, la plantilla no queda creada', async () => {
    const prisma = prismaMock();
    prisma.auditLog.create.mockRejectedValueOnce(new Error('auditoría caída'));
    await expect(new PatientsService(prisma).createTaskTemplate('ws-1', owner, { title: 'Plantilla nueva' })).rejects.toThrow('auditoría caída');
    expect(prisma.__rows('therapeuticTaskTemplate')).toHaveLength(0);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  describe('updateClinicalHistory', () => {
    const history = { id: 'hist-1', patientId: 'patient-1', reasonForConsultation: 'Motivo ficticio' };

    it('actualiza con where { patientId, patient: { workspaceId } } sin upsert solo por patientId', async () => {
      const prisma = prismaMock({ clinicalHistory: [{ ...history }] });
      await new PatientsService(prisma).updateClinicalHistory('ws-1', owner, 'patient-1', { reasonForConsultation: 'Motivo revisado' } as any);
      expect(prisma.clinicalHistory.upsert).not.toHaveBeenCalled();
      expect(prisma.clinicalHistory.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { patientId: 'patient-1', patient: { workspaceId: 'ws-1' } } }));
      expect(prisma.__rows('clinicalHistory')[0].reasonForConsultation).toBe('Motivo revisado');
      expect(prisma.__rows('auditLog')).toEqual([expect.objectContaining({ action: 'CLINICAL_HISTORY_UPDATED', entityId: 'hist-1' })]);
    });

    it('crea la historia si no existe, auditando en la misma transacción', async () => {
      const prisma = prismaMock();
      const saved: any = await new PatientsService(prisma).updateClinicalHistory('ws-1', owner, 'patient-1', { reasonForConsultation: 'Motivo nuevo' } as any);
      expect(prisma.__rows('clinicalHistory')).toEqual([expect.objectContaining({ patientId: 'patient-1', reasonForConsultation: 'Motivo nuevo' })]);
      expect(prisma.__rows('auditLog')).toEqual([expect.objectContaining({ action: 'CLINICAL_HISTORY_UPDATED', entityId: saved.id })]);
    });

    it('si el paciente sale del workspace antes de escribir → 404 y nada creado', async () => {
      const prisma = prismaMock();
      prisma.__beforeTx = (stores: Stores) => { stores.patient.find((p) => p.id === 'patient-1')!.workspaceId = 'ws-2'; };
      await expect(new PatientsService(prisma).updateClinicalHistory('ws-1', owner, 'patient-1', { reasonForConsultation: 'x' } as any)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.__rows('clinicalHistory')).toHaveLength(0);
      expect(prisma.__rows('auditLog')).toHaveLength(0);
    });

    it('si auditLog.create falla, la historia no se modifica', async () => {
      const prisma = prismaMock({ clinicalHistory: [{ ...history }] });
      prisma.auditLog.create.mockRejectedValueOnce(new Error('auditoría caída'));
      await expect(new PatientsService(prisma).updateClinicalHistory('ws-1', owner, 'patient-1', { reasonForConsultation: 'Motivo revisado' } as any)).rejects.toThrow('auditoría caída');
      expect(prisma.__rows('clinicalHistory')[0].reasonForConsultation).toBe('Motivo ficticio');
    });
  });
});

const therapist = { sub: 'therapist-1', workspaceId: 'ws-1', role: 'THERAPIST', email: 't@example.com' } as any;

describe('Tareas: therapyGoalId y sessionId enlazados deben ser del mismo paciente, workspace y terapeuta', () => {
  const linkSeed = () => ({
    patient: [
      { id: 'patient-1', workspaceId: 'ws-1', status: 'ACTIVE', deletedAt: null },
      { id: 'patient-2', workspaceId: 'ws-1', status: 'ACTIVE', deletedAt: null },
      { id: 'patient-ws2', workspaceId: 'ws-2', status: 'ACTIVE', deletedAt: null },
    ],
    therapyGoal: [
      { id: 'goal-own', patientId: 'patient-1', title: 'Objetivo propio' },
      { id: 'goal-other-patient', patientId: 'patient-2', title: 'Objetivo de otro paciente' },
      { id: 'goal-ws2', patientId: 'patient-ws2', title: 'Objetivo de otro workspace' },
    ],
    session: [
      { id: 'ses-own', workspaceId: 'ws-1', patientId: 'patient-1', therapistId: 'therapist-1' },
      { id: 'ses-other-patient', workspaceId: 'ws-1', patientId: 'patient-2', therapistId: 'therapist-1' },
      { id: 'ses-ws2', workspaceId: 'ws-2', patientId: 'patient-ws2', therapistId: 'therapist-9' },
      { id: 'ses-other-therapist', workspaceId: 'ws-1', patientId: 'patient-1', therapistId: 'therapist-2' },
    ],
    therapeuticTask: [{ id: 'task-1', patientId: 'patient-1', status: 'PENDING', title: 'Tarea', therapyGoalId: null, sessionId: null }],
  });

  const invalid: Array<[string, any, any]> = [
    ['objetivo de otro paciente del mismo workspace', owner, { therapyGoalId: 'goal-other-patient' }],
    ['objetivo de otro workspace', owner, { therapyGoalId: 'goal-ws2' }],
    ['objetivo inexistente', owner, { therapyGoalId: 'goal-missing' }],
    ['sesión de otro paciente del mismo workspace', owner, { sessionId: 'ses-other-patient' }],
    ['sesión de otro workspace', owner, { sessionId: 'ses-ws2' }],
    ['sesión inexistente', owner, { sessionId: 'ses-missing' }],
    ['sesión del mismo paciente pero de otro terapeuta (THERAPIST)', therapist, { sessionId: 'ses-other-therapist' }],
  ];

  describe.each(invalid)('%s → 400 sin escritura ni auditoría', (_label, actor, link) => {
    it('al crear', async () => {
      const prisma = prismaMock(linkSeed());
      await expect(new PatientsService(prisma).createTherapeuticTask('ws-1', actor, 'patient-1', { title: 'Nueva', ...link } as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.therapeuticTask.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('al editar', async () => {
      const prisma = prismaMock(linkSeed());
      await expect(new PatientsService(prisma).updateTherapeuticTask('ws-1', actor, 'patient-1', 'task-1', link as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(writesOf(prisma, 'therapeuticTask')).toHaveLength(0);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(prisma.__rows('therapeuticTask')[0]).toEqual(expect.objectContaining({ therapyGoalId: null, sessionId: null }));
    });
  });

  it('la sesión se valida con workspaceId, patientId y therapistId del THERAPIST', async () => {
    const prisma = prismaMock(linkSeed());
    await new PatientsService(prisma).updateTherapeuticTask('ws-1', therapist, 'patient-1', 'task-1', { sessionId: 'ses-own' } as any);
    expect(prisma.session.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ses-own', workspaceId: 'ws-1', patientId: 'patient-1', therapistId: 'therapist-1' },
    }));
  });

  it.each([[owner], [therapist]])('permite enlazar objetivo y sesión propios (%#)', async (actor) => {
    const prisma = prismaMock(linkSeed());
    const service = new PatientsService(prisma);
    await service.createTherapeuticTask('ws-1', actor, 'patient-1', { title: 'Nueva', therapyGoalId: 'goal-own', sessionId: 'ses-own' } as any);
    await service.updateTherapeuticTask('ws-1', actor, 'patient-1', 'task-1', { therapyGoalId: 'goal-own', sessionId: 'ses-own' } as any);
    expect(prisma.__rows('therapeuticTask')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task-1', therapyGoalId: 'goal-own', sessionId: 'ses-own' }),
      expect.objectContaining({ title: 'Nueva', therapyGoalId: 'goal-own', sessionId: 'ses-own' }),
    ]));
  });

  it('desenlazar (null) no requiere validación', async () => {
    const prisma = prismaMock(linkSeed());
    await new PatientsService(prisma).updateTherapeuticTask('ws-1', owner, 'patient-1', 'task-1', { therapyGoalId: null, sessionId: null } as any);
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Portal del paciente (portal/)
// ---------------------------------------------------------------------------------------------

const portal = { portalAccountId: 'pa-1', patientId: 'patient-1', workspaceId: 'ws-1', accessorType: 'PATIENT' };
const account = (overrides: Row = {}): Row => ({
  id: 'pa-1', workspaceId: 'ws-1', patientId: 'patient-1', email: 'paciente@example.com', isActive: true,
  mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null, accessorType: 'PATIENT', passwordHash: 'x', ...overrides,
});
const jwt: any = { signAsync: jest.fn().mockResolvedValue('portal-token') };

describe('Portal: lecturas y escrituras acotadas por workspace, auditoría transaccional', () => {
  it('dashboard filtra las tareas por el workspace del token (patient.workspaceId)', async () => {
    const prisma = prismaMock({ patientPortalAccount: [account()] });
    await new PortalService(prisma, jwt).dashboard(portal);
    expect(prisma.therapeuticTask.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ patientId: 'patient-1', patient: { workspaceId: 'ws-1' } }),
    }));
  });

  it('exportData filtra tareas y evaluaciones por el workspace del token', async () => {
    const prisma = prismaMock({ patientPortalAccount: [account()] });
    await new PortalService(prisma, jwt).exportData(portal);
    for (const model of ['therapeuticTask', 'clinicalAssessment']) {
      expect(prisma[model].findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ patientId: 'patient-1', patient: { workspaceId: 'ws-1' } }),
      }));
    }
  });

  describe.each([
    ['saveTaskProgress', 'PENDING', 'PORTAL_TASK_PROGRESS_SAVED', (s: PortalService) => s.saveTaskProgress(portal, 'task-1', { patientFeedback: 'Respuesta ficticia' })],
    ['submitTask', 'IN_PROGRESS', 'PORTAL_TASK_SUBMITTED', (s: PortalService) => s.submitTask(portal, 'task-1')],
  ] as const)('%s', (_name, status, action, run) => {
    const rows = () => [{ id: 'task-1', patientId: 'patient-1', status, patientFeedback: 'Borrador ficticio', startedAt: null }];

    it('escribe con where { id, patientId, patient.workspaceId } y audita en la transacción', async () => {
      const prisma = prismaMock({ therapeuticTask: rows() });
      await run(new PortalService(prisma, jwt));
      expect(prisma.therapeuticTask.update).not.toHaveBeenCalled();
      expect(prisma.therapeuticTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'task-1', patientId: 'patient-1', patient: { workspaceId: 'ws-1' } }),
      }));
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.__rows('auditLog')).toEqual([expect.objectContaining({ workspaceId: 'ws-1', action, entityId: 'task-1' })]);
    });

    it('si la tarea sale del workspace antes de escribir, no se modifica ni se audita', async () => {
      const prisma = prismaMock({ therapeuticTask: rows() });
      prisma.__beforeTx = (stores: Stores) => { stores.therapeuticTask[0].patientId = 'patient-ws2'; };
      await expect(run(new PortalService(prisma, jwt))).rejects.toBeInstanceOf(HttpException);
      expect(prisma.__rows('therapeuticTask')[0].status).toBe(status);
      expect(prisma.__rows('auditLog')).toHaveLength(0);
    });

    it('si auditLog.create falla, el cambio de la tarea no se confirma', async () => {
      const prisma = prismaMock({ therapeuticTask: rows() });
      prisma.auditLog.create.mockRejectedValueOnce(new Error('auditoría caída'));
      await expect(run(new PortalService(prisma, jwt))).rejects.toThrow('auditoría caída');
      expect(prisma.__rows('therapeuticTask')[0]).toEqual(expect.objectContaining({ status, patientFeedback: 'Borrador ficticio' }));
    });
  });

  describe('changePassword', () => {
    it('lee y escribe la cuenta acotada por workspace y paciente del token, auditando en la transacción', async () => {
      const prisma = prismaMock({ patientPortalAccount: [account({ passwordHash: await bcrypt.hash('Temporal12345', 4) })] });
      await new PortalService(prisma, jwt).changePassword(portal, { currentPassword: 'Temporal12345', newPassword: 'Definitiva12345' } as any);
      expect(prisma.patientPortalAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'pa-1', workspaceId: 'ws-1', patientId: 'patient-1' }),
      }));
      expect(prisma.patientPortalAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'pa-1', workspaceId: 'ws-1', patientId: 'patient-1' }),
      }));
      expect(prisma.patientPortalAccount.update).not.toHaveBeenCalled();
      expect(prisma.__rows('patientPortalAccount')[0].mustChangePassword).toBe(false);
      expect(prisma.__rows('auditLog')).toEqual([expect.objectContaining({ action: 'PORTAL_PASSWORD_CHANGED' })]);
    });

    it('una cuenta de otro workspace no sirve aunque el id coincida', async () => {
      const prisma = prismaMock({ patientPortalAccount: [account({ workspaceId: 'ws-2', passwordHash: await bcrypt.hash('Temporal12345', 4) })] });
      await expect(new PortalService(prisma, jwt).changePassword(portal, { currentPassword: 'Temporal12345', newPassword: 'Definitiva12345' } as any)).rejects.toBeDefined();
      expect(writesOf(prisma, 'patientPortalAccount')).toHaveLength(0);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('si auditLog.create falla, la contraseña no cambia', async () => {
      const hash = await bcrypt.hash('Temporal12345', 4);
      const prisma = prismaMock({ patientPortalAccount: [account({ passwordHash: hash })] });
      prisma.auditLog.create.mockRejectedValueOnce(new Error('auditoría caída'));
      await expect(new PortalService(prisma, jwt).changePassword(portal, { currentPassword: 'Temporal12345', newPassword: 'Definitiva12345' } as any)).rejects.toThrow('auditoría caída');
      expect(prisma.__rows('patientPortalAccount')[0].passwordHash).toBe(hash);
    });
  });

  describe('enable / disable (personal de la consulta)', () => {
    it('reactivar una cuenta existente escribe acotado por workspace y paciente y audita en la transacción', async () => {
      const prisma = prismaMock({ patientPortalAccount: [account({ isActive: false })] });
      await new PortalService(prisma, jwt).enable('ws-1', owner, 'patient-1', { email: 'paciente@example.com', temporaryPassword: 'Temporal12345' } as any);
      expect(prisma.patientPortalAccount.update).not.toHaveBeenCalled();
      expect(prisma.patientPortalAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'pa-1', workspaceId: 'ws-1', patientId: 'patient-1' }),
      }));
      expect(prisma.__rows('patientPortalAccount')[0].isActive).toBe(true);
      expect(prisma.__rows('auditLog')).toEqual([expect.objectContaining({ action: 'PORTAL_ACCOUNT_ENABLED' })]);
    });

    it('enable: si auditLog.create falla, la cuenta no queda creada', async () => {
      const prisma = prismaMock();
      prisma.auditLog.create.mockRejectedValueOnce(new Error('auditoría caída'));
      await expect(new PortalService(prisma, jwt).enable('ws-1', owner, 'patient-1', { email: 'nuevo@example.com', temporaryPassword: 'Temporal12345' } as any)).rejects.toThrow('auditoría caída');
      expect(prisma.__rows('patientPortalAccount')).toHaveLength(0);
    });

    it('disable: si auditLog.create falla, la cuenta sigue activa', async () => {
      const prisma = prismaMock({ patientPortalAccount: [account()] });
      prisma.auditLog.create.mockRejectedValueOnce(new Error('auditoría caída'));
      await expect(new PortalService(prisma, jwt).disable('ws-1', owner, 'patient-1')).rejects.toThrow('auditoría caída');
      expect(prisma.__rows('patientPortalAccount')[0].isActive).toBe(true);
    });
  });

  it('login actualiza los contadores de la cuenta acotando por su workspace, nunca solo por id', async () => {
    const prisma = prismaMock({ patientPortalAccount: [account({ passwordHash: await bcrypt.hash('Correcta12345', 4) })] });
    const service = new PortalService(prisma, jwt);
    await expect(service.login({ email: 'paciente@example.com', password: 'Erronea12345' })).rejects.toBeDefined();
    await service.login({ email: 'paciente@example.com', password: 'Correcta12345' });
    expect(prisma.patientPortalAccount.update).not.toHaveBeenCalled();
    for (const [args] of prisma.patientPortalAccount.updateMany.mock.calls) {
      expect(args.where).toEqual(expect.objectContaining({ id: 'pa-1', workspaceId: 'ws-1' }));
    }
    expect(prisma.patientPortalAccount.updateMany).toHaveBeenCalledTimes(2);
  });

  it('requestDeletion: si la auditoría falla no se crea el aviso al profesional', async () => {
    const prisma = prismaMock();
    prisma.auditLog.create.mockRejectedValueOnce(new Error('auditoría caída'));
    await expect(new PortalService(prisma, jwt).requestDeletion(portal, 'Motivo ficticio')).rejects.toThrow('auditoría caída');
    expect(prisma.__rows('notification')).toHaveLength(0);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
