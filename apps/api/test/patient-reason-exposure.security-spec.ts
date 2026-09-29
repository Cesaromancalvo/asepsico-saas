import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PatientsService } from '../src/patients/patients.service';
import { PatientAccessService } from '../src/patients/patient-access.service';
import { PatientTasksService } from '../src/patients/patient-tasks.service';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { encryptField } from '../src/common/crypto/field-encryption';

/**
 * Regresión del hallazgo ALTA de Argos: Patient.consultationReason salía descifrado en
 * GET /patients, GET /patients/:id, alta/modificación y ciclo de vida, para cualquier rol de
 * staff (ASSISTANT incluido), y un ASSISTANT podía escribirlo. Más los hallazgos MEDIA del mismo
 * informe (títulos de proceso en vistas generales, Message.body en el dashboard, timeline sin
 * filtro de workspace en los modelos hijos).
 *
 * El doble de Prisma devuelve SIEMPRE la fila completa (ignora `select`), que es el peor caso:
 * así se comprueba la proyección explícita de la respuesta, y aparte se comprueba el `select`.
 * Datos 100 % ficticios.
 */

const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER', email: 'o@example.com' } as any;
const admin = { sub: 'admin-1', workspaceId: 'ws-1', role: 'ADMIN', email: 'ad@example.com' } as any;
const therapist = { sub: 'therapist-1', workspaceId: 'ws-1', role: 'THERAPIST', email: 't@example.com' } as any;
const assistant = { sub: 'assistant-1', workspaceId: 'ws-1', role: 'ASSISTANT', email: 'a@example.com' } as any;
const ROLES: [string, any][] = [['OWNER', owner], ['ADMIN', admin], ['THERAPIST', therapist], ['ASSISTANT', assistant]];

const REASON = 'Motivo ficticio de consulta del paciente';
const PROCESS_TITLE = 'Titulo ficticio del proceso clinico';
const PROCESS_REASON = 'Motivo ficticio del proceso';
const NOTES = 'Nota interna ficticia';
const SESSION_NOTES = 'Nota de sesion ficticia';
const MESSAGE_BODY = 'Cuerpo ficticio del mensaje del paciente';
const FORBIDDEN_TEXTS = [REASON, PROCESS_TITLE, PROCESS_REASON, NOTES, SESSION_NOTES];

function fullPatientRow(overrides: Record<string, any> = {}) {
  return {
    id: 'patient-1', workspaceId: 'ws-1', firstName: 'Paciente', lastName: 'Ficticio',
    email: 'paciente@example.com', phone: null, birthDate: null,
    consultationReason: encryptField(REASON),
    status: 'ACTIVE', portalAccessMode: 'PATIENT_ONLY',
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
    deletedAt: null, blockedAt: null, retentionUntil: null,
    _count: { sessions: 1, clinicalProcesses: 1 },
    clinicalProcesses: [{
      id: 'proc-1', title: PROCESS_TITLE, status: 'ACTIVE', modality: 'IN_PERSON', frequency: 'WEEKLY',
      startedAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
      consultationReason: encryptField(PROCESS_REASON), goals: 'x', internalNotes: NOTES,
      therapist: { id: 'therapist-1', firstName: 'T', lastName: 'F', email: 't@example.com' },
      _count: { sessions: 1 },
    }],
    sessions: [{
      id: 'sess-1', clinicalProcessId: 'proc-1', therapistId: 'therapist-1',
      startsAt: new Date('2026-01-01T10:00:00Z'), endsAt: new Date('2026-01-01T11:00:00Z'),
      status: 'COMPLETED', type: 'INDIVIDUAL', location: null, videoCallUrl: null,
      notes: SESSION_NOTES, internalSummary: SESSION_NOTES,
      therapist: { id: 'therapist-1', firstName: 'T', lastName: 'F' },
    }],
    ...overrides,
  };
}

function patientsPrisma() {
  const row = fullPatientRow();
  const prisma: any = {
    patient: {
      findMany: jest.fn(async () => [row]),
      findFirst: jest.fn(async () => row),
      count: jest.fn(async () => 1),
      create: jest.fn(async () => row),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    session: { findMany: jest.fn(async () => []) },
    clinicalProcess: { findFirst: jest.fn(async () => ({ id: 'proc-1' })) },
    auditLog: { create: jest.fn(async () => ({})) },
    patientPortalAccount: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })) },
  };
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  return prisma;
}

function expectNoClinicalContent(value: unknown) {
  const json = JSON.stringify(value);
  expect(json).not.toContain('consultationReason');
  expect(json).not.toMatch(/enc:v[12]:/);
  for (const text of FORBIDDEN_TEXTS) expect(json).not.toContain(text);
  expect(json).not.toContain('"title"');
  expect(json).not.toContain('internalNotes');
  expect(json).not.toContain('"notes"');
}

function expectSelectWithoutClinical(select: any) {
  expect(select).toBeDefined();
  expect(select).not.toHaveProperty('consultationReason');
  expect(select.clinicalProcesses.select).not.toHaveProperty('title');
  expect(select.clinicalProcesses.select).not.toHaveProperty('consultationReason');
  expect(select.sessions.select).not.toHaveProperty('notes');
}

describe('Patients: la vista general nunca expone el motivo de consulta ni títulos de proceso', () => {
  it.each(ROLES)('GET /patients (%s) sin consultationReason, títulos de proceso ni notas', async (_role, actor) => {
    const prisma = patientsPrisma();
    const result = await new PatientsService(prisma).list('ws-1', actor, {} as any);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].firstName).toBe('Paciente');
    expectNoClinicalContent(result);
    const args = prisma.patient.findMany.mock.calls[0][0];
    expect(args.include).toBeUndefined();
    expectSelectWithoutClinical(args.select);
  });

  it.each(ROLES)('GET /patients/:id (%s) sin consultationReason, títulos de proceso ni notas', async (_role, actor) => {
    const prisma = patientsPrisma();
    const result = await new PatientsService(prisma).get('ws-1', actor, 'patient-1');
    expect(result.id).toBe('patient-1');
    expect(result.summary.activeProcess?.id).toBe('proc-1');
    expectNoClinicalContent(result);
    const args = prisma.patient.findFirst.mock.calls[0][0];
    expect(args.include).toBeUndefined();
    expectSelectWithoutClinical(args.select);
  });

  it.each([['OWNER', owner], ['ADMIN', admin], ['THERAPIST', therapist]])(
    'POST /patients (%s) no devuelve consultationReason aunque se haya escrito', async (_role, actor) => {
      const prisma = patientsPrisma();
      const result = await new PatientsService(prisma).create('ws-1', actor, { firstName: 'Paciente', lastName: 'Ficticio', consultationReason: REASON } as any);
      expectNoClinicalContent(result);
      expect(prisma.patient.create.mock.calls[0][0].select).not.toHaveProperty('consultationReason');
    },
  );

  it('PATCH /patients/:id (OWNER) no devuelve consultationReason', async () => {
    const prisma = patientsPrisma();
    const result = await new PatientsService(prisma).update('ws-1', owner, 'patient-1', { consultationReason: REASON } as any);
    expectNoClinicalContent(result);
  });

  it('ciclo de vida (changeStatus, restore, block) no devuelve consultationReason', async () => {
    let prisma = patientsPrisma();
    expectNoClinicalContent(await new PatientsService(prisma).changeStatus('ws-1', owner, 'patient-1', 'PAUSED'));

    prisma = patientsPrisma();
    const archived = fullPatientRow({ status: 'ARCHIVED' });
    prisma.patient.findFirst = jest.fn(async () => archived);
    expectNoClinicalContent(await new PatientsService(prisma).restore('ws-1', owner, 'patient-1'));

    prisma = patientsPrisma();
    expectNoClinicalContent(await new PatientsService(prisma).block('ws-1', owner, 'patient-1'));
  });

  it('changeStatus al mismo estado (atajo sin escritura) tampoco lo devuelve', async () => {
    const prisma = patientsPrisma();
    expectNoClinicalContent(await new PatientsService(prisma).changeStatus('ws-1', assistant, 'patient-1', 'ACTIVE' as any));
  });
});

describe('Patients: ASSISTANT no puede escribir el motivo de consulta', () => {
  it('POST /patients con consultationReason → 403 sin escribir ni auditar', async () => {
    const prisma = patientsPrisma();
    await expect(new PatientsService(prisma).create('ws-1', assistant, { firstName: 'Paciente', lastName: 'Ficticio', consultationReason: REASON } as any))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });

  it('PATCH /patients/:id con consultationReason → 403 sin escribir ni auditar', async () => {
    const prisma = patientsPrisma();
    await expect(new PatientsService(prisma).update('ws-1', assistant, 'patient-1', { consultationReason: REASON } as any))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.patient.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('PATCH con consultationReason vacío también se rechaza (borrarlo es escribirlo)', async () => {
    const prisma = patientsPrisma();
    await expect(new PatientsService(prisma).update('ws-1', assistant, 'patient-1', { consultationReason: '' } as any))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.patient.updateMany).not.toHaveBeenCalled();
  });

  it('POST /patients con consultationReason: null → 403 sin escribir ni auditar', async () => {
    const prisma = patientsPrisma();
    await expect(new PatientsService(prisma).create('ws-1', assistant, { firstName: 'Paciente', lastName: 'Ficticio', consultationReason: null } as any))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.patient.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('PATCH /patients/:id con consultationReason: null → 403 sin escribir ni auditar (null también lo borraría)', async () => {
    const prisma = patientsPrisma();
    await expect(new PatientsService(prisma).update('ws-1', assistant, 'patient-1', { consultationReason: null } as any))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.patient.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('ASSISTANT sigue pudiendo dar de alta y modificar datos administrativos', async () => {
    const prisma = patientsPrisma();
    const service = new PatientsService(prisma);
    await expect(service.create('ws-1', assistant, { firstName: 'Paciente', lastName: 'Ficticio' } as any)).resolves.toBeDefined();
    await expect(service.update('ws-1', assistant, 'patient-1', { phone: '600000000' } as any)).resolves.toBeDefined();
  });
});

describe('GET /patients/:id/consultation-reason (campo clínico)', () => {
  it('ASSISTANT → 403 sin leer el paciente', async () => {
    const prisma = patientsPrisma();
    await expect(new PatientsService(prisma).getConsultationReason('ws-1', assistant, 'patient-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });

  it('THERAPIST sin proceso propio → 403', async () => {
    const prisma = patientsPrisma();
    prisma.clinicalProcess.findFirst = jest.fn(async () => null);
    await expect(new PatientsService(prisma).getConsultationReason('ws-1', therapist, 'patient-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('OWNER de otro workspace → 404 sin fuga (ni el motivo ni si el paciente existe)', async () => {
    const foreignOwner = { sub: 'owner-2', workspaceId: 'ws-2', role: 'OWNER', email: 'o2@example.com' } as any;
    const prisma = patientsPrisma();
    const row = fullPatientRow();
    // El doble respeta el filtro de workspace: el paciente vive en ws-1.
    prisma.patient.findFirst = jest.fn(async (args: any) => (args?.where?.workspaceId === row.workspaceId && args?.where?.id === row.id ? row : null));
    const error = await new PatientsService(prisma).getConsultationReason('ws-2', foreignOwner, 'patient-1').catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.getStatus()).toBe(404);
    const body = JSON.stringify(error.getResponse());
    expect(body).not.toContain(REASON);
    expect(body).not.toContain('patient-1');
    expect(body).not.toMatch(/enc:v[12]:/);
    expect(prisma.patient.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'patient-1', workspaceId: 'ws-2' } }));
  });

  it.each([['OWNER', owner], ['ADMIN', admin], ['THERAPIST', therapist]])('%s lo recibe descifrado, acotado al workspace', async (_role, actor) => {
    const prisma = patientsPrisma();
    const result = await new PatientsService(prisma).getConsultationReason('ws-1', actor, 'patient-1');
    expect(result).toEqual({ patientId: 'patient-1', consultationReason: REASON });
    expect(prisma.patient.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'patient-1', workspaceId: 'ws-1' } }));
  });
});

describe('Dashboard: sin Message.body ni títulos de proceso', () => {
  function dashboardPrisma() {
    return {
      workspaceMember: { findUnique: jest.fn(async () => ({ role: 'OWNER', onboardingStep: 0, onboardingCompletedAt: null, onboardingDismissedAt: null, user: { firstName: 'O', lastName: 'W' } })) },
      session: {
        findMany: jest.fn(async () => [{ id: 's1', startsAt: new Date(Date.now() + 3600_000), status: 'SCHEDULED', patient: { id: 'p1', firstName: 'P', lastName: 'F' }, clinicalProcess: { title: PROCESS_TITLE, modality: 'ONLINE' } }]),
        count: jest.fn(async () => 1),
      },
      patient: { count: jest.fn(async () => 1), findMany: jest.fn(async () => []) },
      therapeuticTask: { findMany: jest.fn(async () => []) },
      message: { findMany: jest.fn(async () => [{ id: 'm1', createdAt: new Date(), body: MESSAGE_BODY, conversation: { patient: { id: 'p1', firstName: 'P', lastName: 'F' } } }]) },
      notificationPreference: { findUnique: jest.fn(async () => null) },
    } as any;
  }

  it.each([['OWNER', owner], ['ADMIN', admin], ['THERAPIST', therapist]])('%s: la consulta de mensajes no carga body y la respuesta no lo contiene', async (_role, actor) => {
    const prisma = dashboardPrisma();
    const result = await new DashboardService(prisma).get(actor);
    const messageArgs = prisma.message.findMany.mock.calls[0][0];
    expect(messageArgs.include).toBeUndefined();
    expect(messageArgs.select).toBeDefined();
    expect(messageArgs.select).not.toHaveProperty('body');
    expect(messageArgs.where.conversation.workspaceId).toBe('ws-1');
    expect(JSON.stringify(result.attention)).not.toContain(MESSAGE_BODY);
    expect(result.summary.unreadMessages).toBe(1);
  });

  it('la consulta de sesiones del panel no pide el título del proceso', async () => {
    const prisma = dashboardPrisma();
    await new DashboardService(prisma).get(owner);
    const sessionArgs = prisma.session.findMany.mock.calls[0][0];
    expect(sessionArgs.select.clinicalProcess.select).not.toHaveProperty('title');
    expect(sessionArgs.select).not.toHaveProperty('notes');
    expect(sessionArgs.select).not.toHaveProperty('internalSummary');
  });
});

describe('Timeline: los modelos hijos se filtran por workspace', () => {
  it('clinicalHistory, therapyGoal, therapeuticTask y clinicalAssessment se acotan por patient.workspaceId', async () => {
    const empty = () => ({ findMany: jest.fn(async () => []) });
    const prisma: any = {
      patient: { findFirst: jest.fn(async () => ({ id: 'patient-1', workspaceId: 'ws-1', status: 'ACTIVE', createdAt: new Date() })) },
      clinicalProcess: { findFirst: jest.fn(async () => ({ id: 'proc-1' })), findMany: jest.fn(async () => []) },
      clinicalHistory: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
      therapyGoal: empty(), therapeuticTask: empty(), clinicalAssessment: empty(), session: empty(),
      patientDocument: empty(), consentRecord: empty(), clinicalReport: empty(), resourceShare: empty(),
    };
    const service = new PatientTasksService(prisma, new PatientAccessService(prisma));
    await service.getTimeline('ws-1', owner, 'patient-1');

    const scoped = { patientId: 'patient-1', patient: { workspaceId: 'ws-1' } };
    expect(prisma.clinicalHistory.findUnique).not.toHaveBeenCalled();
    expect(prisma.clinicalHistory.findFirst.mock.calls[0][0].where).toEqual(scoped);
    expect(prisma.therapyGoal.findMany.mock.calls[0][0].where).toEqual(scoped);
    expect(prisma.therapeuticTask.findMany.mock.calls[0][0].where).toEqual(scoped);
    expect(prisma.clinicalAssessment.findMany.mock.calls[0][0].where).toEqual(scoped);
  });
});
