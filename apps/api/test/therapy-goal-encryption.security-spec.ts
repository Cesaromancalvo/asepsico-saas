import { PatientCareService } from '../src/patients/patient-care.service';
import { PatientTasksService } from '../src/patients/patient-tasks.service';
import { encryptField } from '../src/common/crypto/field-encryption';
import { treatingAccessStub } from './support/clinical-access-fixture';

// Datos 100 % ficticios.
const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER' } as any;
const ENC = /^enc:v1:|^enc:v2:/;
const access: any = treatingAccessStub({ id: 'patient-1', status: 'ACTIVE' });

function prismaWithGoal(goal: any) {
  const tx: any = {
    therapyGoal: {
      create: jest.fn(async ({ data }: any) => ({ id: 'goal-1', status: 'ACTIVE', ...data })),
      updateMany: jest.fn(async ({ data }: any) => { Object.assign(goal, data); return { count: 1 }; }),
      findFirst: jest.fn(async () => goal),
      findMany: jest.fn(async () => [goal]),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  return { ...tx, $transaction: jest.fn(async (cb: any) => cb(tx)) } as any;
}

describe('TherapyGoal: title y description se cifran en reposo', () => {
  it('createTherapyGoal envía title y description cifrados y devuelve en claro', async () => {
    const prisma = prismaWithGoal({});
    const result: any = await new PatientCareService(prisma, access).createTherapyGoal('ws-1', owner, 'patient-1', { title: 'Objetivo ficticio', description: 'Descripción ficticia' } as any);
    const data = prisma.therapyGoal.create.mock.calls[0][0].data;
    expect(data.title).toMatch(ENC);
    expect(data.description).toMatch(ENC);
    expect(result.title).toBe('Objetivo ficticio');
    expect(result.description).toBe('Descripción ficticia');
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('ficticia');
  });

  it('updateTherapyGoal envía title y description cifrados y devuelve en claro', async () => {
    const goal: any = { id: 'goal-1', patientId: 'patient-1', title: encryptField('Antes'), description: null, status: 'ACTIVE' };
    const prisma = prismaWithGoal(goal);
    const result: any = await new PatientCareService(prisma, access).updateTherapyGoal('ws-1', owner, 'patient-1', 'goal-1', { title: 'Nuevo título ficticio', description: 'Nueva descripción ficticia' } as any);
    const data = prisma.therapyGoal.updateMany.mock.calls[0][0].data;
    expect(data.title).toMatch(ENC);
    expect(data.description).toMatch(ENC);
    expect(result.title).toBe('Nuevo título ficticio');
    expect(result.description).toBe('Nueva descripción ficticia');
  });

  it('getTherapyGoals descifra (y sigue leyendo datos antiguos en claro)', async () => {
    const prisma = prismaWithGoal({ id: 'goal-1', title: encryptField('Título ficticio'), description: 'Descripción antigua en claro' });
    const [goal]: any[] = await new PatientCareService(prisma, access).getTherapyGoals('ws-1', owner, 'patient-1');
    expect(goal.title).toBe('Título ficticio');
    expect(goal.description).toBe('Descripción antigua en claro');
  });

  it('listado de tareas (include therapyGoal) y timeline muestran el objetivo descifrado', async () => {
    const encGoal = { id: 'goal-1', title: encryptField('Objetivo ficticio'), description: encryptField('Detalle ficticio'), status: 'ACTIVE', updatedAt: new Date(), achievedAt: null };
    const empty = { findMany: jest.fn(async () => []) };
    const prisma: any = {
      therapeuticTask: { findMany: jest.fn(async () => [{ id: 't1', title: 'Tarea', status: 'PENDING', instructions: null, therapyGoal: { id: 'goal-1', title: encGoal.title, status: 'ACTIVE' }, updatedAt: new Date() }]) },
      patient: { findFirst: jest.fn(async () => ({ id: 'patient-1', createdAt: new Date() })) },
      clinicalHistory: { findFirst: jest.fn(async () => null) },
      therapyGoal: { findMany: jest.fn(async () => [encGoal]) },
      clinicalProcess: empty, session: empty, clinicalAssessment: empty, patientDocument: empty,
      consentRecord: empty, clinicalReport: empty, resourceShare: empty,
    };
    const service = new PatientTasksService(prisma, access);
    const [task]: any[] = await service.getTherapeuticTasks('ws-1', owner, 'patient-1');
    expect(task.therapyGoal.title).toBe('Objetivo ficticio');

    prisma.therapeuticTask.findMany.mockResolvedValueOnce([]);
    const events: any[] = await service.getTimeline('ws-1', owner, 'patient-1');
    const goalEvent = events.find((e) => e.type === 'GOAL');
    expect(goalEvent.title).toBe('Objetivo terapéutico: Objetivo ficticio');
    expect(goalEvent.description).toBe('Detalle ficticio');
    expect(JSON.stringify(events)).not.toMatch(/enc:v[12]:/);
  });
});
