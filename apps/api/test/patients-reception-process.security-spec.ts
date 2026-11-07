import { ForbiddenException } from '@nestjs/common';
import { PatientsService } from '../src/patients/patients.service';
import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';
import { PatientAgendaService } from '../src/sessions/patient-agenda.service';
import { isReceptionRole } from '../src/sessions/session-view.util';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Regla dura 2: ASSISTANT (recepción) no accede a ClinicalProcess. En GET /patients y
 * GET /patients/:id solo recibe del proceso ACTIVO su id, el profesional y hasActiveProcess
 * (para dar citas asociadas al proceso). Nada de estado, modalidad, frecuencia, fechas,
 * recuento de sesiones del proceso ni recuento de procesos; los procesos no activos no salen.
 * OWNER/ADMIN/THERAPIST conservan la vista que ya tenían. Datos 100 % ficticios.
 */

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.now() + days * DAY);
const MARK_TITLE = 'MARK-PROCESS-TITLE';

type Role = 'THERAPIST' | 'OWNER' | 'ADMIN' | 'ASSISTANT';
const actor = (sub: string, role: Role, workspaceId = WS) => ({ sub, role, workspaceId, email: `${sub}@example.com` }) as any;

const process = (id: string, patientId: string, therapistId: string, status: string, modality: string, frequency: string, workspaceId = WS, updatedAt = new Date('2026-03-01')) => ({
  id, workspaceId, patientId, therapistId, status, title: MARK_TITLE, consultationReason: null, goals: null,
  internalNotes: null, modality, frequency, startedAt: new Date('2026-01-01'), endedAt: null, pausedAt: null,
  createdAt: new Date('2026-01-01'), updatedAt,
  // El doble no resuelve relaciones anidadas de Patient: el profesional va ya en la fila (con
  // email, para comprobar que la proyección de recepción lo quita).
  therapist: { id: therapistId, firstName: 'Profesional', lastName: 'Ficticio', email: `${therapistId}@example.com` },
});

function seed() {
  const member = (userId: string, role: Role, isClinician: boolean) => ({ id: `m-${userId}`, workspaceId: WS, userId, role, isClinician });
  const patient = (id: string, lastName: string, workspaceId = WS) => ({
    id, workspaceId, firstName: 'Paciente', lastName, email: null, phone: null, status: 'ACTIVE', deletedAt: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  });
  return fakeClinicalDb({
    workspaceMember: [member('t-a', 'THERAPIST', true), member('t-b', 'THERAPIST', true), member('owner', 'OWNER', false), member('admin', 'ADMIN', false), member('assistant', 'ASSISTANT', false)],
    patient: [patient('pat-1', 'Activo'), patient('pat-2', 'DeAlta'), patient('pat-x', 'OtroEspacio', OTHER_WS)],
    clinicalProcess: [
      // pat-1: un proceso activo (el que usa la agenda) y otro de alta, más reciente.
      process('proc-a', 'pat-1', 't-a', 'ACTIVE', 'HYBRID', 'BIWEEKLY', WS, new Date('2026-02-01')),
      process('proc-old', 'pat-1', 't-b', 'DISCHARGED', 'HYBRID', 'BIWEEKLY', WS, new Date('2026-04-01')),
      // pat-2: solo un proceso de alta.
      process('proc-d', 'pat-2', 't-b', 'DISCHARGED', 'HYBRID', 'BIWEEKLY'),
      // Otro workspace: nunca debe aparecer.
      process('proc-x', 'pat-x', 't-a', 'ACTIVE', 'HYBRID', 'BIWEEKLY', OTHER_WS),
    ],
    session: [{
      id: 'ses-1', workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', clinicalProcessId: 'proc-a', startsAt: at(2),
      endsAt: new Date(at(2).getTime() + 50 * 60 * 1000), status: 'SCHEDULED', type: 'INDIVIDUAL', location: 'Sala 1',
      videoCallUrl: null, notes: null, internalSummary: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    }, {
      // Cita antigua del proceso de alta: su clinicalProcessId (proc-old) no debe llegar a
      // recepción, o podría contar procesos distintos y deducir el recuento que no se le da.
      id: 'ses-old', workspaceId: WS, patientId: 'pat-1', therapistId: 't-b', clinicalProcessId: 'proc-old', startsAt: at(-30),
      endsAt: new Date(at(-30).getTime() + 50 * 60 * 1000), status: 'COMPLETED', type: 'INDIVIDUAL', location: 'Sala 2',
      videoCallUrl: null, notes: null, internalSummary: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    }],
  });
}

const json = (value: unknown) => JSON.stringify(value);
const RECEPTION_THERAPIST = { id: 't-a', firstName: 'Profesional', lastName: 'Ficticio' };

/** Nada del proceso más allá de id + profesional + hasActiveProcess. */
const expectNoProcessMetadata = (value: unknown) => {
  const out = json(value);
  for (const key of ['modality', 'frequency', 'startedAt', 'title', 'processCount', 'allProcesses', 'consultationReason', 'goals', 'internalNotes']) {
    expect(out).not.toContain(`"${key}"`);
  }
  for (const marker of ['HYBRID', 'BIWEEKLY', 'DISCHARGED', MARK_TITLE, 'proc-old', 'proc-d', 'proc-x', '@example.com']) expect(out).not.toContain(marker);
};

describe('Pacientes vistos por recepción (ASSISTANT): sin metadatos del proceso clínico', () => {
  it('GET /patients: ASSISTANT recibe solo id, profesional y hasActiveProcess del proceso activo', async () => {
    const result: any = await new PatientsService(seed() as any).list(WS, actor('assistant', 'ASSISTANT'), {} as any);
    const byId = Object.fromEntries(result.data.map((row: any) => [row.id, row]));
    expect(Object.keys(byId).sort()).toEqual(['pat-1', 'pat-2']);

    expect(byId['pat-1'].summary.activeProcess).toEqual({ id: 'proc-a', therapist: RECEPTION_THERAPIST, hasActiveProcess: true });
    expect(byId['pat-1'].summary.therapist).toEqual(RECEPTION_THERAPIST);
    expect(byId['pat-1'].summary).not.toHaveProperty('processCount');
    expect(byId['pat-1'].summary.activeProcess).not.toHaveProperty('status');
    expect(byId['pat-1'].summary.activeProcess).not.toHaveProperty('_count');

    // Solo un proceso de alta: ni rastro de él.
    expect(byId['pat-2'].summary.activeProcess).toBeNull();
    expect(byId['pat-2'].summary.therapist).toBeNull();
    expectNoProcessMetadata(result);
  });

  it('GET /patients/:id: ASSISTANT recibe solo id, profesional y hasActiveProcess, sin allProcesses ni recuentos', async () => {
    const result: any = await new PatientsService(seed() as any).get(WS, actor('assistant', 'ASSISTANT'), 'pat-1');
    expect(result.id).toBe('pat-1');
    expect(result.summary.activeProcess).toEqual({ id: 'proc-a', therapist: RECEPTION_THERAPIST, hasActiveProcess: true });
    expect(result.summary).not.toHaveProperty('allProcesses');
    expect(result.summary).not.toHaveProperty('processCount');
    expect(result.summary.nextSession?.id).toBe('ses-1');
    expect(json(result.summary.activeProcess)).not.toContain('"status"');
    expect(json(result)).not.toContain('"_count"');
    expectNoProcessMetadata(result);
  });

  it('GET /patients/:id: ASSISTANT no recibe el clinicalProcessId de las citas (ni de un proceso de alta)', async () => {
    const result: any = await new PatientsService(seed() as any).get(WS, actor('assistant', 'ASSISTANT'), 'pat-1');
    expect(result.summary.recentSessions.map((s: any) => s.id).sort()).toEqual(['ses-1', 'ses-old']);
    for (const session of [...result.summary.recentSessions, result.summary.lastSession, result.summary.nextSession]) {
      expect(session).not.toHaveProperty('clinicalProcessId');
    }
    expect(result.summary.lastSession?.id).toBe('ses-old');
    expect(json(result)).not.toContain('"clinicalProcessId"');
    expectNoProcessMetadata(result);
  });

  it('la consulta de sesiones de recepción no pide clinicalProcessId y filtra por workspace', async () => {
    const prisma = seed();
    await new PatientsService(prisma as any).get(WS, actor('assistant', 'ASSISTANT'), 'pat-1');
    const sessions = prisma.patient.findFirst.mock.calls[0][0].select.sessions;
    expect(sessions.select).not.toHaveProperty('clinicalProcessId');
    expect(sessions.where.workspaceId).toBe(WS);
  });

  it('PATCH /patients/:id como ASSISTANT: la respuesta es la vista de recepción', async () => {
    const prisma = seed();
    const result: any = await new PatientsService(prisma as any).update(WS, actor('assistant', 'ASSISTANT'), 'pat-1', { phone: '600000000' } as any);
    expect(result.id).toBe('pat-1');
    expect(result.summary.activeProcess).toEqual({ id: 'proc-a', therapist: RECEPTION_THERAPIST, hasActiveProcess: true });
    expect(result.summary).not.toHaveProperty('allProcesses');
    expect(result.summary).not.toHaveProperty('processCount');
    expect(json(result)).not.toContain('"clinicalProcessId"');
    expectNoProcessMetadata(result);
    expect(prisma.__store.auditLog.map((log: any) => log.action)).toContain('PATIENT_UPDATED');
  });

  it('changeStatus sin cambio de estado como ASSISTANT: devuelve la vista de recepción sin escribir', async () => {
    const prisma = seed();
    const result: any = await new PatientsService(prisma as any).changeStatus(WS, actor('assistant', 'ASSISTANT'), 'pat-1', 'ACTIVE' as any);
    expect(result.status).toBe('ACTIVE');
    expect(result.summary.activeProcess).toEqual({ id: 'proc-a', therapist: RECEPTION_THERAPIST, hasActiveProcess: true });
    expect(result.summary).not.toHaveProperty('allProcesses');
    expect(result.summary).not.toHaveProperty('processCount');
    expect(json(result)).not.toContain('"clinicalProcessId"');
    expectNoProcessMetadata(result);
    expect(prisma.patient.updateMany).not.toHaveBeenCalled();
    expect(prisma.__store.auditLog).toHaveLength(0);
  });

  it('GET /patients/:id: ASSISTANT con un paciente sin proceso activo → activeProcess null, sin DISCHARGED', async () => {
    const result: any = await new PatientsService(seed() as any).get(WS, actor('assistant', 'ASSISTANT'), 'pat-2');
    expect(result.summary.activeProcess).toBeNull();
    expectNoProcessMetadata(result);
  });

  it('la consulta de recepción filtra por workspace y ACTIVE y no pide estado, modalidad ni fechas', async () => {
    const prisma = seed();
    await new PatientsService(prisma as any).list(WS, actor('assistant', 'ASSISTANT'), {} as any);
    await new PatientsService(prisma as any).get(WS, actor('assistant', 'ASSISTANT'), 'pat-1');
    const calls = [prisma.patient.findMany.mock.calls[0][0], prisma.patient.findFirst.mock.calls[0][0]];
    for (const args of calls) {
      expect(args.where.workspaceId).toBe(WS);
      expect(args.select.clinicalProcesses.where).toEqual({ workspaceId: WS, status: 'ACTIVE' });
      expect(Object.keys(args.select.clinicalProcesses.select).sort()).toEqual(['id', 'therapist']);
      expect(args.select.clinicalProcesses.select.therapist.select).not.toHaveProperty('email');
      expect(args.select._count.select).toEqual({ sessions: true });
    }
  });

  it('otro workspace: ASSISTANT no ve el paciente ajeno (404)', async () => {
    await expect(new PatientsService(seed() as any).get(WS, actor('assistant', 'ASSISTANT'), 'pat-x')).rejects.toThrow('Paciente no encontrado');
  });

  it('GET /clinical-processes/:id con el id que da la agenda → ASSISTANT 403', async () => {
    const prisma = seed();
    const agenda: any = await new PatientAgendaService(prisma as any).agenda(WS, actor('assistant', 'ASSISTANT'), 'pat-1');
    const processId = agenda.data.find((row: any) => row.id === 'ses-1').clinicalProcessId;
    expect(processId).toBe('proc-a');
    await expect(new ClinicalProcessesService(prisma as any).get(WS, actor('assistant', 'ASSISTANT'), processId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('agenda del paciente: para recepción la consulta no carga la relación clinicalProcess', async () => {
    const prisma = seed();
    await new PatientAgendaService(prisma as any).agenda(WS, actor('assistant', 'ASSISTANT'), 'pat-1');
    const args = prisma.session.findMany.mock.calls[0][0];
    expect(args.where.workspaceId).toBe(WS);
    expect(args.select).not.toHaveProperty('clinicalProcess');
  });

  it('cualquier rol que no sea OWNER/ADMIN/THERAPIST recibe la vista de recepción (falla en cerrado)', () => {
    for (const role of ['ASSISTANT', 'PATIENT', '', undefined, null, 'owner']) expect(isReceptionRole(role as any)).toBe(true);
    for (const role of ['OWNER', 'ADMIN', 'THERAPIST']) expect(isReceptionRole(role)).toBe(false);
  });

  it.each([['owner', 'OWNER'], ['admin', 'ADMIN']] as const)(
    'GET /patients/:id: %s conserva estado, modalidad, frecuencia y todos los procesos', async (sub, role) => {
      const result: any = await new PatientsService(seed() as any).get(WS, actor(sub, role), 'pat-1');
      expect(result.summary.activeProcess).toMatchObject({ id: 'proc-a', status: 'ACTIVE', modality: 'HYBRID', frequency: 'BIWEEKLY' });
      expect(result.summary.allProcesses.map((p: any) => p.id).sort()).toEqual(['proc-a', 'proc-old']);
      // La vista clínica conserva el clinicalProcessId de cada cita.
      expect(result.summary.recentSessions.find((s: any) => s.id === 'ses-old')?.clinicalProcessId).toBe('proc-old');
      expect(result.summary).toHaveProperty('processCount');
      expect(json(result)).not.toContain(MARK_TITLE);
    });

  it('GET /patients: THERAPIST conserva estado y modalidad de su proceso', async () => {
    const result: any = await new PatientsService(seed() as any).list(WS, actor('t-a', 'THERAPIST'), {} as any);
    // (El filtro por proceso propio lo cubre patients-access; el doble no aplica `some`.)
    const row = result.data.find((item: any) => item.id === 'pat-1');
    expect(row.summary.activeProcess).toMatchObject({ id: 'proc-a', status: 'ACTIVE', modality: 'HYBRID' });
    expect(json(result)).not.toContain(MARK_TITLE);
  });
});
