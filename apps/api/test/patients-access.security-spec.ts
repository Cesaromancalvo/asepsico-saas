import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PatientsService } from '../src/patients/patients.service';

const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER', email: 'o@example.com' };
const therapist = { sub: 'therapist-1', workspaceId: 'ws-1', role: 'THERAPIST', email: 't@example.com' };
const assistant = { sub: 'assistant-1', workspaceId: 'ws-1', role: 'ASSISTANT', email: 'a@example.com' };

function prismaMock() {
  const tx: any = {
    clinicalAssessment: { create: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  return {
    patient: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    clinicalProcess: { findFirst: jest.fn() },
    clinicalAssessment: { findMany: jest.fn(), findFirst: jest.fn() },
    therapeuticTask: { findMany: jest.fn() },
    clinicalHistory: { findUnique: jest.fn() },
    therapyGoal: { findFirst: jest.fn() },
    session: { findFirst: jest.fn() },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
    __tx: tx,
  } as any;
}

describe('PatientsService clinical authorization', () => {
  it('oculta contenido clínico a ASSISTANT', async () => {
    const prisma = prismaMock();
    const service = new PatientsService(prisma);
    await expect(service.getClinicalAssessments('ws-1', assistant as any, 'patient-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });

  it('oculta la existencia de pacientes de otro workspace', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue(null);
    const service = new PatientsService(prisma);
    await expect(service.getClinicalAssessments('ws-1', owner as any, 'patient-from-ws-2')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.patient.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'patient-from-ws-2', workspaceId: 'ws-1' } }));
  });

  it('bloquea THERAPIST sin proceso asignado', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue({ id: 'patient-1', status: 'ACTIVE' });
    prisma.clinicalProcess.findFirst.mockResolvedValue(null);
    const service = new PatientsService(prisma);
    await expect(service.getClinicalAssessments('ws-1', therapist as any, 'patient-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechaza respuestas fuera del rango real de PHQ-9', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue({ id: 'patient-1', status: 'ACTIVE' });
    const service = new PatientsService(prisma);
    await expect(service.createClinicalAssessment('ws-1', owner as any, 'patient-1', {
      scaleCode: 'PHQ9', answers: [0,0,0,0,0,0,0,0,4],
    } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('marca riesgo cuando PHQ-9 item 9 es positivo y audita', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue({ id: 'patient-1', status: 'ACTIVE' });
    prisma.__tx.clinicalAssessment.create.mockImplementation(async ({ data }: any) => ({ id: 'assessment-1', ...data }));
    const service = new PatientsService(prisma);
    const result: any = await service.createClinicalAssessment('ws-1', owner as any, 'patient-1', {
      scaleCode: 'PHQ9', answers: [0,0,0,0,0,0,0,0,1],
    } as any);
    expect(result.riskFlag).toBe(true);
    expect(result.interpretation).toContain('valoración clínica inmediata');
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: 'ws-1', actorId: 'owner-1', action: 'CLINICAL_ASSESSMENT_CREATED' }),
    }));
  });

  it('limita el listado de THERAPIST a pacientes asignados y filtra procesos y sesiones anidadas', async () => {
    const prisma = prismaMock();
    prisma.patient.findMany.mockResolvedValue([]);
    prisma.patient.count.mockResolvedValue(0);
    prisma.session = { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() };
    const service = new PatientsService(prisma);

    await service.list('ws-1', therapist as any, {} as any);

    const args = prisma.patient.findMany.mock.calls[0][0];
    expect(args.where).toEqual(expect.objectContaining({
      workspaceId: 'ws-1',
      clinicalProcesses: { some: { workspaceId: 'ws-1', therapistId: 'therapist-1' } },
    }));
    expect(args.include.clinicalProcesses.where).toEqual({ workspaceId: 'ws-1', therapistId: 'therapist-1' });
    expect(args.include.sessions.where.therapistId).toBe('therapist-1');
  });

  it('no permite que THERAPIST abra la ficha administrativa de un paciente no asignado', async () => {
    const prisma = prismaMock();
    prisma.patient.findFirst.mockResolvedValue(null);
    const service = new PatientsService(prisma);

    await expect(service.get('ws-1', therapist as any, 'patient-2')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.patient.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'patient-2',
        workspaceId: 'ws-1',
        clinicalProcesses: { some: { workspaceId: 'ws-1', therapistId: 'therapist-1' } },
      }),
    }));
  });

});
