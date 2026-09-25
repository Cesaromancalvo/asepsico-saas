import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PatientsService } from '../src/patients/patients.service';
import { PatientCoreService } from '../src/patients/patient-core.service';
import { PatientLifecycleService } from '../src/patients/patient-lifecycle.service';

// Datos 100 % ficticios.
const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER', email: 'o@example.com' };
const admin = { sub: 'admin-1', workspaceId: 'ws-1', role: 'ADMIN', email: 'ad@example.com' };
const therapist = { sub: 'therapist-1', workspaceId: 'ws-1', role: 'THERAPIST', email: 't@example.com' };
const otherTherapist = { sub: 'therapist-2', workspaceId: 'ws-1', role: 'THERAPIST', email: 't2@example.com' };
const assistant = { sub: 'assistant-1', workspaceId: 'ws-1', role: 'ASSISTANT', email: 'a@example.com' };

type FakePatient = {
  id: string;
  workspaceId: string;
  therapistId: string;
  status: string;
  firstName: string;
  lastName: string;
  consultationReason: string | null;
  deletedAt: Date | null;
  blockedAt?: Date | null;
  retentionUntil?: Date | null;
};

/**
 * Mock de Prisma con un pequeño almacén en memoria. $transaction ejecuta el callback con el
 * MISMO mock y, si el callback lanza, restaura la instantánea previa (simula el ROLLBACK).
 * Así se puede comprobar que un fallo de auditoría no deja el cambio de estado confirmado.
 */
function prismaMock(seed: FakePatient[]) {
  let store: FakePatient[] = seed.map((p) => ({ ...p }));

  const matches = (p: FakePatient, where: any) =>
    (where.id === undefined || p.id === where.id) &&
    (where.workspaceId === undefined || p.workspaceId === where.workspaceId) &&
    (where.clinicalProcesses?.some?.therapistId === undefined ||
      p.therapistId === where.clinicalProcesses.some.therapistId);

  const shape = (p: FakePatient) => ({
    ...p,
    _count: { sessions: 0, clinicalProcesses: 1 },
    clinicalProcesses: [],
    sessions: [],
  });

  const prisma: any = {
    patient: {
      findFirst: jest.fn(async ({ where }: any) => {
        const found = store.find((p) => matches(p, where));
        return found ? shape(found) : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        store = store.map((p) => {
          if (!matches(p, where)) return p;
          count += 1;
          return { ...p, ...data };
        });
        return { count };
      }),
      update: jest.fn(async () => {
        throw new Error('patient.update no debe usarse: las escrituras deben filtrar por workspaceId');
      }),
    },
    auditLog: { create: jest.fn(async ({ data }: any) => ({ id: 'audit-1', ...data })) },
    $transaction: jest.fn(async (cb: any) => {
      const snapshot = store.map((p) => ({ ...p }));
      try {
        return await cb(prisma);
      } catch (error) {
        store = snapshot;
        throw error;
      }
    }),
    __status: (id: string) => store.find((p) => p.id === id)?.status,
  };
  return prisma;
}

const patient = (overrides: Partial<FakePatient> = {}): FakePatient => ({
  id: 'patient-1',
  workspaceId: 'ws-1',
  therapistId: 'therapist-1',
  status: 'ACTIVE',
  firstName: 'Paciente',
  lastName: 'Ficticio',
  consultationReason: null,
  deletedAt: null,
  ...overrides,
});

const foreignPatient = patient({ id: 'patient-ws2', workspaceId: 'ws-2', therapistId: 'therapist-9' });

function expectNoWrites(prisma: any) {
  expect(prisma.patient.updateMany).not.toHaveBeenCalled();
  expect(prisma.patient.update).not.toHaveBeenCalled();
  expect(prisma.auditLog.create).not.toHaveBeenCalled();
}

describe('PatientLifecycleService — aislamiento, roles y auditoría transaccional', () => {
  describe('block()', () => {
    it.each([['THERAPIST', therapist], ['ASSISTANT', assistant]])('rechaza %s con ForbiddenException sin escrituras ni auditoría', async (_role, actor) => {
      const prisma = prismaMock([patient()]);
      const service = new PatientsService(prisma);
      await expect(service.block('ws-1', actor as any, 'patient-1')).rejects.toBeInstanceOf(ForbiddenException);
      expectNoWrites(prisma);
      expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    });

    it('permite a OWNER y ADMIN, filtrando la escritura por workspaceId y auditando en la transacción', async () => {
      for (const actor of [owner, admin]) {
        const prisma = prismaMock([patient()]);
        const service = new PatientsService(prisma);
        const result: any = await service.block('ws-1', actor as any, 'patient-1');
        expect(result.status).toBe('BLOCKED');
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.patient.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'patient-1', workspaceId: 'ws-1' } }),
        );
        expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-1', actorId: actor.sub, action: 'PATIENT_BLOCKED', entityId: 'patient-1',
            metadata: expect.objectContaining({ previousStatus: 'ACTIVE' }),
          }),
        }));
      }
    });
  });

  describe('paciente de otro workspace', () => {
    it.each([
      ['block', (s: PatientsService) => s.block('ws-1', owner as any, 'patient-ws2')],
      ['changeStatus', (s: PatientsService) => s.changeStatus('ws-1', owner as any, 'patient-ws2', 'PAUSED')],
      ['restore', (s: PatientsService) => s.restore('ws-1', owner as any, 'patient-ws2')],
      ['archive', (s: PatientsService) => s.archive('ws-1', owner as any, 'patient-ws2')],
    ])('%s → NotFoundException sin update ni auditLog', async (_name, run) => {
      const prisma = prismaMock([patient(), { ...foreignPatient, status: 'ARCHIVED' }]);
      const service = new PatientsService(prisma);
      await expect(run(service)).rejects.toBeInstanceOf(NotFoundException);
      expectNoWrites(prisma);
      expect(prisma.__status('patient-ws2')).toBe('ARCHIVED');
    });
  });

  it('toda escritura del ciclo de vida lleva workspaceId en el where', async () => {
    const prisma = prismaMock([
      patient({ id: 'p-status' }),
      patient({ id: 'p-archive' }),
      patient({ id: 'p-restore', status: 'ARCHIVED' }),
      patient({ id: 'p-block' }),
    ]);
    const service = new PatientsService(prisma);
    await service.changeStatus('ws-1', owner as any, 'p-status', 'PAUSED');
    await service.archive('ws-1', owner as any, 'p-archive');
    await service.restore('ws-1', owner as any, 'p-restore');
    await service.block('ws-1', owner as any, 'p-block');

    expect(prisma.patient.update).not.toHaveBeenCalled();
    expect(prisma.patient.updateMany).toHaveBeenCalledTimes(4);
    for (const [args] of prisma.patient.updateMany.mock.calls) {
      expect(args.where).toEqual(expect.objectContaining({ workspaceId: 'ws-1' }));
      expect(args.where.id).toBeDefined();
    }
    expect(prisma.$transaction).toHaveBeenCalledTimes(4);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(4);
  });

  describe('si la auditoría falla dentro de la transacción, el cambio no se confirma', () => {
    it.each([
      ['changeStatus', 'ACTIVE', (s: PatientsService) => s.changeStatus('ws-1', owner as any, 'patient-1', 'PAUSED')],
      ['archive', 'ACTIVE', (s: PatientsService) => s.archive('ws-1', owner as any, 'patient-1')],
      ['restore', 'ARCHIVED', (s: PatientsService) => s.restore('ws-1', owner as any, 'patient-1')],
      ['block', 'ACTIVE', (s: PatientsService) => s.block('ws-1', owner as any, 'patient-1')],
    ])('%s propaga el error y deja el estado original', async (_name, initial, run) => {
      const prisma = prismaMock([patient({ status: initial })]);
      prisma.auditLog.create.mockRejectedValueOnce(new Error('fallo de auditoría simulado'));
      const service = new PatientsService(prisma);
      await expect(run(service)).rejects.toThrow('fallo de auditoría simulado');
      expect(prisma.patient.updateMany).toHaveBeenCalled();
      expect(prisma.__status('patient-1')).toBe(initial);
    });

    it('update() de datos del paciente también es transaccional', async () => {
      const prisma = prismaMock([patient()]);
      prisma.auditLog.create.mockRejectedValueOnce(new Error('fallo de auditoría simulado'));
      const service = new PatientsService(prisma);
      await expect(service.update('ws-1', owner as any, 'patient-1', { firstName: 'Otro' } as any))
        .rejects.toThrow('fallo de auditoría simulado');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.patient.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'patient-1', workspaceId: 'ws-1' } }),
      );
    });
  });

  describe('transiciones no permitidas → BadRequestException sin escrituras', () => {
    it.each([
      ['BLOCKED', 'ACTIVE'],
      ['BLOCKED', 'PAUSED'],
      ['ARCHIVED', 'PAUSED'],
      ['ARCHIVED', 'ACTIVE'],
      ['DISCHARGED', 'PAUSED'],
    ])('%s → %s', async (from, to) => {
      const prisma = prismaMock([patient({ status: from })]);
      const service = new PatientsService(prisma);
      await expect(service.changeStatus('ws-1', owner as any, 'patient-1', to as any))
        .rejects.toBeInstanceOf(BadRequestException);
      expectNoWrites(prisma);
    });

    it('bloquear un paciente ya bloqueado → BadRequestException', async () => {
      const prisma = prismaMock([patient({ status: 'BLOCKED' })]);
      const service = new PatientsService(prisma);
      await expect(service.block('ws-1', owner as any, 'patient-1')).rejects.toBeInstanceOf(BadRequestException);
      expectNoWrites(prisma);
    });

    it('restaurar un paciente no archivado → BadRequestException', async () => {
      const prisma = prismaMock([patient({ status: 'ACTIVE' })]);
      const service = new PatientsService(prisma);
      await expect(service.restore('ws-1', owner as any, 'patient-1')).rejects.toBeInstanceOf(BadRequestException);
      expectNoWrites(prisma);
    });
  });

  describe('THERAPIST solo sobre sus pacientes', () => {
    it('no puede cambiar el estado de un paciente que no es suyo (se oculta como NotFound)', async () => {
      const prisma = prismaMock([patient({ therapistId: 'therapist-1' })]);
      const service = new PatientsService(prisma);
      await expect(service.changeStatus('ws-1', otherTherapist as any, 'patient-1', 'PAUSED'))
        .rejects.toBeInstanceOf(NotFoundException);
      expectNoWrites(prisma);
      expect(prisma.__status('patient-1')).toBe('ACTIVE');
    });

    it('sí puede cambiar el estado de su propio paciente', async () => {
      const prisma = prismaMock([patient({ therapistId: 'therapist-1' })]);
      const service = new PatientsService(prisma);
      const result: any = await service.changeStatus('ws-1', therapist as any, 'patient-1', 'PAUSED');
      expect(result.status).toBe('PAUSED');
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'PATIENT_STATUS_CHANGED', metadata: { from: 'ACTIVE', to: 'PAUSED' } }),
      }));
    });
  });

  it('el camino con inyección de Nest (core separado) aplica las mismas garantías', async () => {
    const prisma = prismaMock([patient(), foreignPatient]);
    const lifecycle = new PatientLifecycleService(prisma, new PatientCoreService(prisma));
    await expect(lifecycle.changeStatus('ws-1', owner as any, 'patient-ws2', 'PAUSED')).rejects.toBeInstanceOf(NotFoundException);
    await expect(lifecycle.block('ws-1', therapist as any, 'patient-1')).rejects.toBeInstanceOf(ForbiddenException);
    expectNoWrites(prisma);
    const result: any = await lifecycle.changeStatus('ws-1', owner as any, 'patient-1', 'PAUSED');
    expect(result.status).toBe('PAUSED');
    expect(prisma.patient.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'patient-1', workspaceId: 'ws-1' } }),
    );
  });
});
