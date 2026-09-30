import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { PatientCareService } from '../src/patients/patient-care.service';
import { PatientTasksService } from '../src/patients/patient-tasks.service';
import { encryptField } from '../src/common/crypto/field-encryption';

/**
 * Regresión de los hallazgos de Argos que quedaron fuera de la PR #13:
 *  1. GET /clinical-processes (listado) devolvía las sesiones completas con notes/internalSummary
 *     (y la narrativa del propio proceso). Los listados nunca devuelven narrativa clínica.
 *  2. GET /clinical-processes/:id devolvía el paciente completo (patient: true), con
 *     Patient.consultationReason, que solo se sirve desde /patients/:id/consultation-reason.
 *  3. Historia clínica, objetivos y tareas se leían filtrando solo por patientId; ahora también
 *     por el workspace del paciente (patientChildScope), como defensa en profundidad.
 *  + GET /sessions (agenda, visible para ASSISTANT) devolvía notes, internalSummary y el título
 *     del proceso clínico.
 *
 * Los dobles de Prisma devuelven SIEMPRE la fila completa (ignoran `select`): peor caso, así se
 * comprueba la proyección de la respuesta; aparte se comprueba el `select` enviado a Prisma.
 * Datos 100 % ficticios.
 */

const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER', email: 'o@example.com' } as any;
const admin = { sub: 'admin-1', workspaceId: 'ws-1', role: 'ADMIN', email: 'ad@example.com' } as any;
const therapist = { sub: 'therapist-1', workspaceId: 'ws-1', role: 'THERAPIST', email: 't@example.com' } as any;
const assistant = { sub: 'assistant-1', workspaceId: 'ws-1', role: 'ASSISTANT', email: 'a@example.com' } as any;
const CLINICAL: [string, any][] = [['OWNER', owner], ['ADMIN', admin], ['THERAPIST', therapist]];
const STAFF: [string, any][] = [...CLINICAL, ['ASSISTANT', assistant]];

const PATIENT_REASON = 'Motivo ficticio del paciente';
const PROCESS_TITLE = 'Titulo ficticio del proceso';
const PROCESS_REASON = 'Motivo ficticio del proceso';
const PROCESS_GOALS = 'Objetivos ficticios del proceso';
const PROCESS_NOTES = 'Notas internas ficticias del proceso';
const SESSION_NOTES = 'Nota ficticia de la sesion';
const SESSION_SUMMARY = 'Resumen interno ficticio de la sesion';

function sessionRow(id = 'sess-1') {
  return {
    id, workspaceId: 'ws-1', patientId: 'patient-1', therapistId: 'therapist-1', clinicalProcessId: 'proc-1',
    startsAt: new Date('2026-01-01T10:00:00Z'), endsAt: new Date('2026-01-01T11:00:00Z'),
    status: 'COMPLETED', type: 'INDIVIDUAL', location: null, videoCallUrl: null,
    notes: encryptField(SESSION_NOTES), internalSummary: encryptField(SESSION_SUMMARY),
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  };
}

function patientRow() {
  return {
    id: 'patient-1', workspaceId: 'ws-1', firstName: 'Paciente', lastName: 'Ficticio',
    email: 'paciente@example.com', phone: null, birthDate: null,
    consultationReason: encryptField(PATIENT_REASON),
    status: 'ACTIVE', portalAccessMode: 'PATIENT_ONLY',
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
    deletedAt: null, blockedAt: null, retentionUntil: null,
  };
}

function processRow() {
  return {
    id: 'proc-1', workspaceId: 'ws-1', patientId: 'patient-1', therapistId: 'therapist-1',
    title: PROCESS_TITLE, consultationReason: encryptField(PROCESS_REASON), goals: encryptField(PROCESS_GOALS),
    internalNotes: encryptField(PROCESS_NOTES), modality: 'IN_PERSON', frequency: 'WEEKLY', status: 'ACTIVE',
    startedAt: new Date('2026-01-01'), endedAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
    patient: patientRow(),
    therapist: { id: 'therapist-1', firstName: 'T', lastName: 'F', email: 't@example.com' },
    sessions: [sessionRow('sess-1'), sessionRow('sess-2')],
    _count: { sessions: 2 },
  };
}

function expectNoNarrative(value: unknown, forbidden: string[]) {
  const json = JSON.stringify(value);
  expect(json).not.toMatch(/enc:v[12]:/);
  for (const text of forbidden) expect(json).not.toContain(text);
}

describe('GET /clinical-processes (listado) sin notas de sesión ni narrativa clínica', () => {
  it.each(CLINICAL)('%s: las sesiones del listado son solo metadatos', async (_role, actor) => {
    const prisma: any = {
      clinicalProcess: { findMany: jest.fn(async () => [processRow()]), count: jest.fn(async () => 1) },
    };
    const result = await new ClinicalProcessesService(prisma).list('ws-1', actor, {} as any);

    expect(result.data).toHaveLength(1);
    const [row] = result.data as any[];
    expect(row.id).toBe('proc-1');
    expect(row.sessions).toHaveLength(2);
    expect(row.sessions[0]).toMatchObject({ id: 'sess-1', status: 'COMPLETED' });
    for (const session of row.sessions) {
      expect(session).not.toHaveProperty('notes');
      expect(session).not.toHaveProperty('internalSummary');
    }
    for (const field of ['consultationReason', 'goals', 'internalNotes']) expect(row).not.toHaveProperty(field);
    expect(row.patient).not.toHaveProperty('consultationReason');
    expectNoNarrative(result, [SESSION_NOTES, SESSION_SUMMARY, PROCESS_REASON, PROCESS_GOALS, PROCESS_NOTES, PATIENT_REASON]);

    const args = prisma.clinicalProcess.findMany.mock.calls[0][0];
    expect(args.include).toBeUndefined();
    expect(args.select.sessions.select).toBeDefined();
    expect(args.select.sessions.select).not.toHaveProperty('notes');
    expect(args.select.sessions.select).not.toHaveProperty('internalSummary');
    for (const field of ['consultationReason', 'goals', 'internalNotes']) expect(args.select).not.toHaveProperty(field);
  });
});

describe('GET /clinical-processes/:id no devuelve el motivo de consulta del paciente', () => {
  it.each(CLINICAL)('%s: paciente proyectado con la vista general', async (_role, actor) => {
    const prisma: any = { clinicalProcess: { findFirst: jest.fn(async () => processRow()) } };
    const result: any = await new ClinicalProcessesService(prisma).get('ws-1', actor, 'proc-1');

    expect(result.patient).toMatchObject({ id: 'patient-1', firstName: 'Paciente' });
    expect(result.patient).not.toHaveProperty('consultationReason');
    expect(JSON.stringify(result.patient)).not.toMatch(/enc:v[12]:/);
    expect(JSON.stringify(result)).not.toContain(PATIENT_REASON);
    // El detalle del proceso sí conserva su propio contenido clínico (descifrado).
    expect(result.consultationReason).toBe(PROCESS_REASON);

    const args = prisma.clinicalProcess.findFirst.mock.calls[0][0];
    expect(args.where).toMatchObject({ id: 'proc-1', workspaceId: 'ws-1' });
    expect(args.include.patient).not.toBe(true);
    expect(args.include.patient.select).not.toHaveProperty('consultationReason');
  });
});

describe('GET /sessions (agenda) sin notas ni título del proceso', () => {
  it.each(STAFF)('%s: solo metadatos de la sesión', async (_role, actor) => {
    const full = { ...sessionRow(), patient: patientRow(), therapist: { id: 'therapist-1', firstName: 'T', lastName: 'F' }, clinicalProcess: processRow() };
    const prisma: any = { session: { findMany: jest.fn(async () => [full]), count: jest.fn(async () => 1) } };
    const result: any = await new SessionsService(prisma).list('ws-1', actor, {} as any);

    const [row] = result.data;
    expect(row).toMatchObject({ id: 'sess-1', status: 'COMPLETED', clinicalProcess: { id: 'proc-1', modality: 'IN_PERSON', status: 'ACTIVE' } });
    expect(row).not.toHaveProperty('notes');
    expect(row).not.toHaveProperty('internalSummary');
    expect(row.clinicalProcess).not.toHaveProperty('title');
    expect(row.patient).not.toHaveProperty('consultationReason');
    expectNoNarrative(result, [SESSION_NOTES, SESSION_SUMMARY, PROCESS_TITLE, PROCESS_REASON, PATIENT_REASON]);

    const args = prisma.session.findMany.mock.calls[0][0];
    expect(args.include).toBeUndefined();
    expect(args.select).not.toHaveProperty('notes');
    expect(args.select).not.toHaveProperty('internalSummary');
    expect(args.select.clinicalProcess.select).not.toHaveProperty('title');
  });
});

/**
 * Doble de Prisma que SÍ aplica el filtro de workspace a través de la relación `patient`: el
 * paciente pertenece a ws-2, pero el control de acceso (stub) deja pasar la petición de ws-1
 * (simula un fallo o carrera en esa comprobación). Solo una lectura acotada con
 * patientChildScope deja de devolver las filas del otro workspace.
 */
function crossTenantPrisma() {
  const patients = [{ id: 'patient-1', workspaceId: 'ws-2' }];
  const matches = (row: any, where: any = {}) => Object.entries(where).every(([key, filter]: [string, any]) => {
    if (key === 'patient') {
      const p = patients.find((x) => x.id === row.patientId);
      return Boolean(p) && Object.entries(filter).every(([k, v]) => (p as any)[k] === v);
    }
    return row[key] === filter;
  });
  const store = {
    clinicalHistory: [{ id: 'h-1', patientId: 'patient-1', reasonForConsultation: encryptField(PATIENT_REASON) }],
    therapyGoal: [{ id: 'g-1', patientId: 'patient-1', title: encryptField(PROCESS_GOALS), description: null }],
    therapeuticTask: [{ id: 't-1', patientId: 'patient-1', title: encryptField(PROCESS_NOTES), instructions: null }],
  } as Record<string, any[]>;
  const model = (name: string) => ({
    findUnique: jest.fn(async ({ where }: any) => store[name].find((r) => matches(r, where)) ?? null),
    findFirst: jest.fn(async ({ where }: any) => store[name].find((r) => matches(r, where)) ?? null),
    findMany: jest.fn(async ({ where }: any) => store[name].filter((r) => matches(r, where))),
  });
  return { clinicalHistory: model('clinicalHistory'), therapyGoal: model('therapyGoal'), therapeuticTask: model('therapeuticTask') } as any;
}
const permissiveAccess: any = { assertPatientClinicalAccess: jest.fn(async () => ({ id: 'patient-1', workspaceId: 'ws-1', status: 'ACTIVE' })) };

describe('Lecturas hijas del paciente acotadas también por workspace (patientChildScope)', () => {
  it('GET /patients/:id/history no devuelve la historia de un paciente de otro workspace', async () => {
    const prisma = crossTenantPrisma();
    const result: any = await new PatientCareService(prisma, permissiveAccess).getClinicalHistory('ws-1', owner, 'patient-1');
    expect(result.id).toBeUndefined();
    expect(result.reasonForConsultation).toBeNull();
    expect(JSON.stringify(result)).not.toContain(PATIENT_REASON);
  });

  it('GET /patients/:id/goals no devuelve objetivos de un paciente de otro workspace', async () => {
    const prisma = crossTenantPrisma();
    const result = await new PatientCareService(prisma, permissiveAccess).getTherapyGoals('ws-1', owner, 'patient-1');
    expect(result).toEqual([]);
    expect(prisma.therapyGoal.findMany.mock.calls[0][0].where).toMatchObject({ patientId: 'patient-1', patient: { workspaceId: 'ws-1' } });
  });

  it('GET /patients/:id/tasks no devuelve tareas de un paciente de otro workspace', async () => {
    const prisma = crossTenantPrisma();
    const result = await new PatientTasksService(prisma, permissiveAccess).getTherapeuticTasks('ws-1', owner, 'patient-1');
    expect(result).toEqual([]);
    expect(prisma.therapeuticTask.findMany.mock.calls[0][0].where).toMatchObject({ patientId: 'patient-1', patient: { workspaceId: 'ws-1' } });
  });
});
