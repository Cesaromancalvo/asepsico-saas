import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PatientsService } from '../src/patients/patients.service';
import { CsrfGuard } from '../src/common/guards/csrf.guard';

const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER' } as any;
const therapist = { sub: 'therapist-1', workspaceId: 'ws-1', role: 'THERAPIST' } as any;
const assistant = { sub: 'assistant-1', workspaceId: 'ws-1', role: 'ASSISTANT' } as any;

function prismaMock() {
  const tx: any = {
    clinicalAssessment: { create: jest.fn(), delete: jest.fn() },
    patientDocument: { create: jest.fn(), delete: jest.fn() },
    consentRecord: { create: jest.fn(), delete: jest.fn() },
    clinicalReport: { create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  return {
    patient: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    clinicalProcess: { findFirst: jest.fn(), findMany: jest.fn() },
    session: { findMany: jest.fn() },
    clinicalHistory: { findUnique: jest.fn() },
    therapyGoal: { findMany: jest.fn() },
    therapeuticTask: { findMany: jest.fn() },
    clinicalAssessment: { findMany: jest.fn(), findFirst: jest.fn() },
    patientDocument: { findMany: jest.fn(), findFirst: jest.fn() },
    consentRecord: { findMany: jest.fn(), findFirst: jest.fn() },
    clinicalReport: { findMany: jest.fn(), findFirst: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    __tx: tx,
  } as any;
}

describe('security integration: clinical modules', () => {
  it('scopes therapist patient list and nested session/process metadata to that therapist', async () => {
    const prisma = prismaMock();
    prisma.patient.findMany.mockResolvedValue([]);
    prisma.patient.count.mockResolvedValue(0);
    const service = new PatientsService(prisma);

    await service.list('ws-1', therapist, {} as any);

    const args = prisma.patient.findMany.mock.calls[0][0];
    expect(args.where).toEqual(expect.objectContaining({
      workspaceId: 'ws-1',
      clinicalProcesses: { some: { therapistId: 'therapist-1', workspaceId: 'ws-1' } },
    }));
    expect(args.include.clinicalProcesses.where).toEqual({ therapistId: 'therapist-1' });
    expect(args.include.sessions.where.therapistId).toBe('therapist-1');
  });

  it('blocks a therapist from opening a patient assigned only to another therapist', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue({ id: 'patient-2' });
    prisma.clinicalProcess.findFirst.mockResolvedValue(null);
    const service = new PatientsService(prisma);

    await expect(service.get('ws-1', therapist, 'patient-2')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks assistants from clinical history, goals, tasks and assessments', async () => {
    const prisma = prismaMock();
    const service = new PatientsService(prisma);

    await expect(service.getClinicalHistory('ws-1', assistant, 'p1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getTherapyGoals('ws-1', assistant, 'p1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getTherapeuticTasks('ws-1', assistant, 'p1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getClinicalAssessments('ws-1', assistant, 'p1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not reveal whether a patient exists in another workspace', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue(null);
    const service = new PatientsService(prisma);

    await expect(service.get('ws-1', owner, 'foreign-patient')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.patient.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'foreign-patient', workspaceId: 'ws-1' },
    }));
  });


  it('blocks assistants from documents, consents and clinical reports', async () => {
    const prisma = prismaMock();
    const service = new PatientsService(prisma);
    await expect(service.getPatientDocuments('ws-1', assistant, 'p1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getConsentRecords('ws-1', assistant, 'p1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getClinicalReports('ws-1', assistant, 'p1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('scopes document deletion by workspace and patient', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue({ id: 'p1', status: 'ACTIVE' });
    prisma.patientDocument.findFirst.mockResolvedValue(null);
    const service = new PatientsService(prisma);
    await expect(service.deletePatientDocument('ws-1', owner, 'p1', 'foreign-doc')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.patientDocument.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign-doc', patientId: 'p1', workspaceId: 'ws-1' } });
  });

  it('prevents destructive deletion of finalized reports', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue({ id: 'p1', status: 'ACTIVE' });
    prisma.clinicalReport.findFirst.mockResolvedValue({ id: 'r1', patientId: 'p1', workspaceId: 'ws-1', status: 'FINAL', type: 'EVOLUTION' });
    const service = new PatientsService(prisma);
    await expect(service.deleteClinicalReport('ws-1', owner, 'p1', 'r1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('audits document creation without storing narrative content in audit metadata', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue({ id: 'p1', status: 'ACTIVE' });
    prisma.__tx.patientDocument.create.mockImplementation(async ({ data }: any) => ({ id: 'd1', ...data }));
    const service = new PatientsService(prisma);
    await service.createPatientDocument('ws-1', owner, 'p1', { title: 'Informe externo', type: 'EXTERNAL_REPORT', description: 'contenido sensible' } as any);
    const audit = prisma.__tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.metadata).toEqual(expect.objectContaining({ patientId: 'p1', type: 'EXTERNAL_REPORT' }));
    expect(audit.metadata).not.toHaveProperty('description');
    expect(audit.metadata).not.toHaveProperty('storageKey');
  });

  it('creates a PHQ-9 risk assessment and writes a non-narrative audit event atomically', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue({ id: 'p1', status: 'ACTIVE' });
    prisma.__tx.clinicalAssessment.create.mockImplementation(async ({ data }: any) => ({ id: 'a1', ...data }));
    const service = new PatientsService(prisma);

    const result: any = await service.createClinicalAssessment('ws-1', owner, 'p1', {
      scaleCode: 'PHQ9',
      answers: [0, 1, 1, 1, 1, 1, 1, 1, 1],
      clinicalNotes: '  seguimiento clínico  ',
    } as any);

    expect(result.riskFlag).toBe(true);
    expect(result.totalScore).toBe(8);
    expect(result.clinicalNotes).toBe('seguimiento clínico');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: 'ws-1', actorId: 'owner-1' }),
    }));
    const auditData = prisma.__tx.auditLog.create.mock.calls[0][0].data;
    expect(auditData.metadata).not.toHaveProperty('answers');
    expect(auditData.metadata).not.toHaveProperty('clinicalNotes');
  });
});

describe('CSRF guard', () => {
  const guard = new CsrfGuard();
  function context(method: string, cookie?: string, header?: string): any {
    const req = {
      method,
      cookies: cookie ? { csrf_token: cookie } : {},
      header: (name: string) => name === 'x-csrf-token' ? header : undefined,
    };
    return { switchToHttp: () => ({ getRequest: () => req }) };
  }

  it('allows safe methods without a token', () => {
    expect(guard.canActivate(context('GET'))).toBe(true);
  });

  it('rejects state-changing requests without a matching double-submit token', () => {
    expect(() => guard.canActivate(context('POST'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context('PATCH', 'one', 'two'))).toThrow(ForbiddenException);
  });

  it('allows state-changing requests with matching cookie and header tokens', () => {
    expect(guard.canActivate(context('DELETE', 'same-token', 'same-token'))).toBe(true);
  });
});

describe('JWT production configuration', () => {
  it('refuses to start with the development fallback secret in production', async () => {
    const previousEnv = process.env.NODE_ENV;
    const previousSecret = process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    jest.resetModules();
    const { getJwtSecret } = await import('../src/auth/jwt-secret.util');
    expect(() => getJwtSecret()).toThrow('JWT_SECRET es obligatorio en producción');
    process.env.NODE_ENV = previousEnv;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
});
