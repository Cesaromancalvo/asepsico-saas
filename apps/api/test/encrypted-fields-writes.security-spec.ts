import { ENCRYPTED_JSON_FIELDS, ENCRYPTED_TEXT_FIELDS } from '../src/common/crypto/clinical-crypto';
import { decryptField, encryptField } from '../src/common/crypto/field-encryption';
import { PatientCareService } from '../src/patients/patient-care.service';
import { PatientTasksService } from '../src/patients/patient-tasks.service';
import { PatientRecordsService } from '../src/patients/patient-records.service';
import { PatientAssessmentsService } from '../src/patients/patient-assessments.service';
import { PatientCoreService } from '../src/patients/patient-core.service';
import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { MessagesService } from '../src/messages/messages.service';
import { PortalService } from '../src/portal/portal.service';
import { AuthService } from '../src/auth/auth.service';

/**
 * Test tabla-driven: por CADA campo marcado como cifrado en common/crypto/clinical-crypto.ts,
 * al menos un camino de escritura real de la API y TODOS los de la tabla que lo tocan deben
 * entregar a Prisma un valor "enc:v1:"/"enc:v2:". Si alguien añade un campo al registro sin
 * cubrirlo aquí, el primer test falla; si un servicio escribe en claro, falla el suyo.
 * Datos 100 % ficticios.
 */

const ENC = /^enc:v1:|^enc:v2:/;
const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER', email: 'owner@example.com' } as any;
const portal = { portalAccountId: 'acc-1', patientId: 'patient-1', workspaceId: 'ws-1', accessorType: 'PATIENT' };
const access: any = { assertPatientClinicalAccess: jest.fn(async () => ({ id: 'patient-1', status: 'ACTIVE' })) };
const WRITE_METHODS = new Set(['create', 'update', 'updateMany', 'upsert']);

type Call = { model: string; method: string; args: any };

/** Prisma de grabación: responde filas plausibles y registra todas las llamadas de escritura. */
function recordingPrisma(rows: Record<string, Record<string, any>> = {}) {
  const calls: Call[] = [];
  const base = {
    id: 'row-1', workspaceId: 'ws-1', patientId: 'patient-1', therapistId: 'owner-1', status: 'ACTIVE',
    createdAt: new Date(), updatedAt: new Date(), startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000),
    email: 'ficticio@example.com', firstName: 'Paciente', lastName: 'Ficticio', totpSecret: null, totpEnabled: false,
    patientCanReply: true, signedAt: null, portalAccessMode: 'PATIENT_ONLY', patientFeedback: null,
  };
  const models = new Map<string, any>();
  const model = (name: string) => {
    if (!models.has(name)) {
      const row = () => ({ ...base, ...(rows[name] ?? {}) });
      const record = (method: string, impl: (args: any) => any) => jest.fn(async (args: any) => { calls.push({ model: name, method, args }); return impl(args); });
      models.set(name, {
        findFirst: record('findFirst', row), findUnique: record('findUnique', row), findMany: record('findMany', () => []),
        count: record('count', () => 0), create: record('create', (a) => ({ ...row(), ...a.data })),
        update: record('update', (a) => ({ ...row(), ...a.data })), upsert: record('upsert', (a) => ({ ...row(), ...a.create })),
        updateMany: record('updateMany', () => ({ count: 1 })), deleteMany: record('deleteMany', () => ({ count: 1 })),
        createMany: record('createMany', () => ({ count: 1 })),
      });
    }
    return models.get(name);
  };
  const prisma: any = new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop === '$transaction') return async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg));
      if (prop === 'then' || typeof prop !== 'string') return undefined;
      return model(prop);
    },
  });
  return { prisma, calls };
}

type Case = { name: string; writes: Record<string, string[]>; run: (prisma: any) => Promise<unknown>; rows?: Record<string, Record<string, any>> };
const text = (label: string) => `Texto ficticio (${label})`;

const CASES: Case[] = [
  { name: 'PatientCore.create', writes: { patient: ['consultationReason'] },
    run: (p) => new PatientCoreService(p).create('ws-1', owner, { firstName: 'Paciente', lastName: 'Ficticio', consultationReason: text('motivo') } as any) },
  { name: 'PatientCore.update', writes: { patient: ['consultationReason'] }, rows: { patient: { clinicalProcesses: [], sessions: [], _count: { sessions: 0, clinicalProcesses: 0 } } },
    run: (p) => new PatientCoreService(p).update('ws-1', owner, 'patient-1', { consultationReason: text('motivo') } as any) },
  { name: 'PatientCare.updateClinicalHistory', writes: { clinicalHistory: [...ENCRYPTED_TEXT_FIELDS.clinicalHistory] },
    run: (p) => new PatientCareService(p, access).updateClinicalHistory('ws-1', owner, 'patient-1', Object.fromEntries(ENCRYPTED_TEXT_FIELDS.clinicalHistory.map((f) => [f, text(f)])) as any) },
  { name: 'PatientCare.createTherapyGoal', writes: { therapyGoal: ['title', 'description'] },
    run: (p) => new PatientCareService(p, access).createTherapyGoal('ws-1', owner, 'patient-1', { title: text('título'), description: text('descripción') } as any) },
  { name: 'PatientCare.updateTherapyGoal', writes: { therapyGoal: ['title', 'description'] },
    run: (p) => new PatientCareService(p, access).updateTherapyGoal('ws-1', owner, 'patient-1', 'goal-1', { title: text('título'), description: text('descripción') } as any) },
  { name: 'PatientTasks.createTherapeuticTask', writes: { therapeuticTask: ['title', 'instructions'] },
    run: (p) => new PatientTasksService(p, access).createTherapeuticTask('ws-1', owner, 'patient-1', { title: text('título'), instructions: text('instrucciones') } as any) },
  { name: 'PatientTasks.updateTherapeuticTask', writes: { therapeuticTask: ['title', 'instructions', 'clinicianNotes', 'reviewComment'] },
    run: (p) => new PatientTasksService(p, access).updateTherapeuticTask('ws-1', owner, 'patient-1', 'task-1', { title: text('t'), instructions: text('i'), clinicianNotes: text('n'), reviewComment: text('r') } as any) },
  { name: 'Portal.saveTaskProgress', writes: { therapeuticTask: ['patientFeedback'] }, rows: { therapeuticTask: { status: 'PENDING', startedAt: null } },
    run: (p) => new PortalService(p, {} as any).saveTaskProgress(portal, 'task-1', { patientFeedback: text('respuesta') } as any) },
  { name: 'PatientTasks.createTaskTemplate', writes: { therapeuticTaskTemplate: ['instructions'] },
    run: (p) => new PatientTasksService(p, access).createTaskTemplate('ws-1', owner, { title: 'Plantilla', instructions: text('instrucciones') } as any) },
  { name: 'PatientTasks.updateTaskTemplate', writes: { therapeuticTaskTemplate: ['instructions'] },
    run: (p) => new PatientTasksService(p, access).updateTaskTemplate('ws-1', owner, 'tpl-1', { instructions: text('instrucciones') } as any) },
  { name: 'ClinicalProcesses.create', writes: { clinicalProcess: ['consultationReason', 'goals', 'internalNotes'] },
    run: (p) => new ClinicalProcessesService(p).create('ws-1', owner, { patientId: 'patient-1', therapistId: 'owner-1', title: 'Proceso', consultationReason: text('m'), goals: text('g'), internalNotes: text('n') } as any) },
  { name: 'ClinicalProcesses.update', writes: { clinicalProcess: ['consultationReason', 'goals', 'internalNotes'] },
    run: (p) => new ClinicalProcessesService(p).update('ws-1', owner, 'proc-1', { consultationReason: text('m'), goals: text('g'), internalNotes: text('n') } as any) },
  { name: 'Sessions.updateNotes', writes: { session: ['notes', 'internalSummary'] },
    run: (p) => new SessionsService(p).updateNotes('ws-1', owner, 'session-1', { notes: text('notas'), internalSummary: text('resumen') } as any) },
  { name: 'PatientAssessments.createClinicalAssessment', writes: { clinicalAssessment: ['interpretation', 'clinicalNotes', 'answers'] },
    run: (p) => new PatientAssessmentsService(p, access).createClinicalAssessment('ws-1', owner, 'patient-1', { scaleCode: 'GAD7', answers: [1, 1, 1, 1, 1, 1, 1], clinicalNotes: text('notas') } as any) },
  { name: 'PatientRecords.createClinicalReport', writes: { clinicalReport: ['content'] },
    run: (p) => new PatientRecordsService(p, access).createClinicalReport('ws-1', owner, 'patient-1', { title: 'Informe', type: 'EVOLUTION', content: text('contenido') } as any) },
  { name: 'PatientRecords.updateClinicalReport', writes: { clinicalReport: ['content'] }, rows: { clinicalReport: { status: 'DRAFT' } },
    run: (p) => new PatientRecordsService(p, access).updateClinicalReport('ws-1', owner, 'patient-1', 'rep-1', { content: text('contenido') } as any) },
  { name: 'PatientRecords.createPatientDocument', writes: { patientDocument: ['description', 'fileName'] },
    run: (p) => new PatientRecordsService(p, access).createPatientDocument('ws-1', owner, 'patient-1', { title: 'Doc', type: 'CLINICAL', description: text('d'), fileName: 'informe-ficticio.pdf' } as any) },
  { name: 'PatientRecords.createConsentRecord', writes: { consentRecord: ['notes'] },
    run: (p) => new PatientRecordsService(p, access).createConsentRecord('ws-1', owner, 'patient-1', { type: 'INFORMED_CONSENT', status: 'PENDING', notes: text('notas') } as any) },
  { name: 'PatientRecords.updateConsentRecord', writes: { consentRecord: ['notes'] }, rows: { consentRecord: { status: 'PENDING' } },
    run: (p) => new PatientRecordsService(p, access).updateConsentRecord('ws-1', owner, 'patient-1', 'cons-1', { notes: text('notas') } as any) },
  { name: 'Messages.send', writes: { message: ['body', 'attachmentName'] }, rows: { conversation: { status: 'OPEN' } },
    run: (p) => new MessagesService(p).send('ws-1', owner, 'conv-1', { body: text('mensaje'), attachmentName: 'adjunto-ficticio.pdf', attachmentKey: 'key-1', mimeType: 'application/pdf' } as any) },
  { name: 'Messages.portalSend', writes: { message: ['body', 'attachmentName'] }, rows: { conversation: { status: 'OPEN', patientCanReply: true } },
    run: (p) => new MessagesService(p).portalSend(portal, { body: text('mensaje'), attachmentName: 'adjunto-ficticio.pdf', attachmentKey: 'key-1', mimeType: 'application/pdf' } as any) },
  { name: 'Auth.setupMfa', writes: { user: ['totpSecret'] },
    run: (p) => new AuthService(p, {} as any).setupMfa('owner-1') },
];

function registeredFields(): string[] {
  const text = Object.entries(ENCRYPTED_TEXT_FIELDS).flatMap(([m, fs]) => (fs as readonly string[]).map((f) => `${m}.${f}`));
  const json = Object.entries(ENCRYPTED_JSON_FIELDS).flatMap(([m, fs]) => (fs as readonly string[]).map((f) => `${m}.${f}`));
  return [...text, ...json].sort();
}

describe('Todo campo marcado como cifrado llega cifrado a Prisma en sus escrituras', () => {
  it('la tabla cubre todos los campos del registro (añadir un campo obliga a añadir su caso)', () => {
    const covered = new Set(CASES.flatMap((c) => Object.entries(c.writes).flatMap(([m, fs]) => fs.map((f) => `${m}.${f}`))));
    expect(registeredFields().filter((f) => !covered.has(f))).toEqual([]);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, testCase) => {
    const { prisma, calls } = recordingPrisma(testCase.rows);
    await testCase.run(prisma);
    for (const [model, fields] of Object.entries(testCase.writes)) {
      const writes = calls.filter((c) => c.model === model && WRITE_METHODS.has(c.method));
      for (const field of fields) {
        const values = writes
          .map((c) => (c.method === 'upsert' ? { ...c.args.create, ...c.args.update } : c.args.data))
          .filter((data) => data && field in data && data[field] !== undefined && data[field] !== null)
          .map((data) => data[field]);
        expect({ field: `${model}.${field}`, written: values.length > 0 }).toEqual({ field: `${model}.${field}`, written: true });
        for (const value of values) {
          expect({ field: `${model}.${field}`, value }).toEqual({ field: `${model}.${field}`, value: expect.stringMatching(ENC) });
          expect(decryptField(value)).not.toMatch(ENC);
        }
      }
    }
  });
});

describe('Portal: al descifrar tareas nunca se entregan las notas privadas del profesional', () => {
  it('saveTaskProgress devuelve la tarea descifrada sin clinicianNotes', async () => {
    const { prisma } = recordingPrisma({ therapeuticTask: { status: 'PENDING', startedAt: null, instructions: encryptField('Instrucción ficticia'), clinicianNotes: encryptField('Nota privada ficticia') } });
    const result: any = await new PortalService(prisma, {} as any).saveTaskProgress(portal, 'task-1', { patientFeedback: 'Respuesta ficticia' } as any);
    expect(result).not.toHaveProperty('clinicianNotes');
    expect(result.instructions).toBe('Instrucción ficticia');
    expect(JSON.stringify(result)).not.toContain('Nota privada ficticia');
    expect(JSON.stringify(result)).not.toMatch(/enc:v[12]:/);
  });
});
