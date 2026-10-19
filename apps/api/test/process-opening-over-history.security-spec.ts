import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';
import { CreateClinicalProcessDto } from '../src/clinical-processes/dto/create-clinical-process.dto';
import { ChangeClinicalProcessStatusDto } from '../src/clinical-processes/dto/change-clinical-process-status.dto';
import { completeExistingPatient } from '../src/patient-import/patient-import-writes';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * H6 — cerrar el atajo de abrirse o reactivar un proceso sobre historia ajena
 * (docs/producto/acceso-excepcional.md §3.8, CA6.1–CA6.10). Datos 100 % ficticios.
 */

const WS = 'ws-1';
const d = (iso: string) => new Date(iso);
const actor = (sub: string, role: string, workspaceId = WS) => ({ sub, workspaceId, role, email: `${sub}@example.com` }) as any;

const OWNER_C = actor('owner-c', 'OWNER');
const ADMIN = actor('admin-nc', 'ADMIN');
const T_A = actor('t-a', 'THERAPIST');
const T_B = actor('t-b', 'THERAPIST');

const proc = (id: string, patientId: string, therapistId: string, status: string, createdAt: string, workspaceId = WS) => ({
  id, workspaceId, patientId, therapistId, status, title: 'Proceso ficticio', consultationReason: null, goals: null, internalNotes: null,
  modality: 'IN_PERSON', frequency: null, startedAt: d(createdAt), endedAt: status === 'ACTIVE' ? null : d(createdAt), pausedAt: null,
  createdAt: d(createdAt), updatedAt: d(createdAt), openingReasonCode: null,
});
const patient = (id: string, firstName: string, lastName: string, workspaceId = WS) => ({
  id, workspaceId, firstName, lastName, status: 'ACTIVE', deletedAt: null, blockedAt: null, consultationReason: null, createdAt: d('2026-01-01'),
});

function seed() {
  return fakeClinicalDb({
    user: ['owner-c', 'owner-2', 'admin-nc', 't-a', 't-b', 'assistant'].map((id) => ({ id, firstName: 'Nombre', lastName: id })),
    workspaceMember: [
      { id: 'm1', workspaceId: WS, userId: 'owner-c', role: 'OWNER', isClinician: true },
      { id: 'm2', workspaceId: WS, userId: 'owner-2', role: 'OWNER', isClinician: false },
      { id: 'm3', workspaceId: WS, userId: 'admin-nc', role: 'ADMIN', isClinician: false },
      { id: 'm4', workspaceId: WS, userId: 't-a', role: 'THERAPIST', isClinician: true },
      { id: 'm5', workspaceId: WS, userId: 't-b', role: 'THERAPIST', isClinician: true },
      { id: 'm6', workspaceId: WS, userId: 'assistant', role: 'ASSISTANT', isClinician: false },
      { id: 'm7', workspaceId: 'ws-2', userId: 'owner-x', role: 'OWNER', isClinician: true },
    ],
    patient: [
      patient('pat-1', 'Ana', 'Ficticia'),
      patient('pat-new', 'Nuevo', 'Ficticio'),
      patient('pat-own', 'Propio', 'Ficticio'),
      patient('pat-r', 'Reactiva', 'Ficticia'),
      patient('pat-e', 'Anterior', 'Ficticia'),
      patient('pat-x', 'Otro', 'Workspace', 'ws-2'),
    ],
    clinicalProcess: [
      proc('proc-a', 'pat-1', 't-a', 'CLOSED', '2026-01-01T00:00:00Z'),
      // Autor que ya no es miembro: no recibe aviso.
      proc('proc-gone', 'pat-1', 't-gone', 'DISCHARGED', '2025-06-01T00:00:00Z'),
      proc('proc-own', 'pat-own', 't-b', 'DISCHARGED', '2026-01-01T00:00:00Z'),
      // Reactivación con un proceso POSTERIOR de otro autor.
      proc('proc-r1', 'pat-r', 't-b', 'DISCHARGED', '2026-01-01T00:00:00Z'),
      proc('proc-r2', 'pat-r', 't-a', 'ACTIVE', '2026-03-01T00:00:00Z'),
      // Reactivación con solo procesos ANTERIORES de otro autor: flujo de hoy.
      proc('proc-e1', 'pat-e', 't-a', 'CLOSED', '2026-01-01T00:00:00Z'),
      proc('proc-e2', 'pat-e', 't-b', 'PAUSED', '2026-03-01T00:00:00Z'),
      proc('proc-x', 'pat-x', 'owner-x', 'ACTIVE', '2026-01-01T00:00:00Z', 'ws-2'),
    ],
  });
}

const store = (prisma: any) => prisma.__store;
const processesOf = (prisma: any, patientId: string) => store(prisma).clinicalProcess.filter((row: any) => row.patientId === patientId);
const errorBody = (error: any) => error.getResponse();

async function expectRejected(run: () => Promise<unknown>, type: any, code?: string) {
  let caught: any;
  try { await run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(type);
  if (code) expect(errorBody(caught).code).toBe(code);
}

function expectNothingCreated(prisma: any, patientId: string, before: number) {
  expect(processesOf(prisma, patientId)).toHaveLength(before);
  expect(store(prisma).clinicalProcessOpening).toHaveLength(0);
  expect(store(prisma).notification).toHaveLength(0);
  expect(store(prisma).auditLog.filter((row: any) => row.action !== 'CLINICAL_ACCESS_DENIED')).toHaveLength(0);
}

describe('H6 · apertura de proceso sobre historia ajena', () => {
  it('CA6.1 THERAPIST que se abre un proceso con un paciente con historia ajena → 403 auditado, sin crear nada', async () => {
    const prisma = seed();
    await expectRejected(
      () => new ClinicalProcessesService(prisma).create(WS, T_B, { patientId: 'pat-1', title: 'Proceso' } as any),
      ForbiddenException, 'PATIENT_HAS_FOREIGN_HISTORY',
    );
    expectNothingCreated(prisma, 'pat-1', 2);
    const denied = store(prisma).auditLog.filter((row: any) => row.action === 'CLINICAL_ACCESS_DENIED');
    expect(denied).toEqual([expect.objectContaining({
      workspaceId: WS, actorId: 't-b', entityId: 'pat-1',
      metadata: { resource: 'clinical-process-open-over-history', reason: 'FOREIGN_HISTORY', role: 'THERAPIST' },
    })]);
  });

  it('CA6.1 un THERAPIST no lo esquiva enviando un código de apertura', async () => {
    const prisma = seed();
    await expectRejected(
      () => new ClinicalProcessesService(prisma).create(WS, T_B, { patientId: 'pat-1', title: 'Proceso', openingReasonCode: 'SUBSTITUTION' } as any),
      ForbiddenException,
    );
    expectNothingCreated(prisma, 'pat-1', 2);
  });

  it.each([
    ['OWNER clínico a sí mismo', OWNER_C, undefined],
    ['ADMIN a otro profesional', ADMIN, 't-b'],
  ])('CA6.2 %s sin openingReasonCode → 400 OPENING_REASON_REQUIRED y no se crea nada', async (_l, who, therapistId) => {
    const prisma = seed();
    await expectRejected(
      () => new ClinicalProcessesService(prisma).create(WS, who, { patientId: 'pat-1', title: 'Proceso', therapistId: therapistId ?? who.sub } as any),
      BadRequestException, 'OPENING_REASON_REQUIRED',
    );
    expectNothingCreated(prisma, 'pat-1', 2);
    expect(store(prisma).auditLog).toHaveLength(0);
  });

  it('CA6.2 código fuera del catálogo (OTHER) → 400 en el servicio y en el DTO', async () => {
    const prisma = seed();
    await expectRejected(
      () => new ClinicalProcessesService(prisma).create(WS, OWNER_C, { patientId: 'pat-1', title: 'Proceso', therapistId: 'owner-c', openingReasonCode: 'OTHER' } as any),
      BadRequestException,
    );
    expectNothingCreated(prisma, 'pat-1', 2);
    const createErrors = await validate(plainToInstance(CreateClinicalProcessDto, { patientId: 'pat-1', title: 'Proceso', openingReasonCode: 'OTHER' }));
    expect(createErrors.map((e) => e.property)).toContain('openingReasonCode');
    const statusErrors = await validate(plainToInstance(ChangeClinicalProcessStatusDto, { status: 'ACTIVE', openingReasonCode: 'OTHER' }));
    expect(statusErrors.map((e) => e.property)).toContain('openingReasonCode');
  });

  it('CA6.3 + CA6.6 OWNER que se lo abre a sí mismo con código: proceso, auditoría solo con códigos, aviso al titular miembro y revisión en 72 h', async () => {
    const prisma = seed();
    const before = Date.now();
    const result: any = await new ClinicalProcessesService(prisma).create(WS, OWNER_C, { patientId: 'pat-1', title: 'Proceso', therapistId: 'owner-c', openingReasonCode: 'SUBSTITUTION' } as any);
    const created = processesOf(prisma, 'pat-1').find((row: any) => row.id === result.id);
    expect(created).toMatchObject({ therapistId: 'owner-c', openingReasonCode: 'SUBSTITUTION', workspaceId: WS });

    const audit = store(prisma).auditLog.find((row: any) => row.action === 'CLINICAL_PROCESS_OPENED_OVER_HISTORY');
    expect(audit.metadata).toEqual({ reasonCode: 'SUBSTITUTION', targetTherapistId: 'owner-c', selfAssigned: true });

    const [opening] = store(prisma).clinicalProcessOpening;
    expect(opening).toMatchObject({ workspaceId: WS, patientId: 'pat-1', kind: 'OPENED', selfAssigned: true, ownerCountAtCreation: 2, actorRole: 'OWNER' });
    const due = opening.ownerReviewDueAt.getTime() - opening.createdAt.getTime();
    expect(due).toBe(72 * 60 * 60 * 1000);
    expect(opening.createdAt.getTime()).toBeGreaterThanOrEqual(before);

    // Aviso solo a t-a (t-gone ya no es miembro), en la app, sin texto clínico.
    const notices = store(prisma).notification;
    expect(notices.map((n: any) => n.userId)).toEqual(['t-a']);
    expect(notices[0]).toMatchObject({ workspaceId: WS, audience: 'PROFESSIONAL', type: 'CLINICAL_ACCESS_NOTICE' });
    expect(notices[0].body).toContain('A. F.');
    expect(notices[0].body).toContain('Sustitución de otro profesional');
    expect(notices[0].body).not.toContain('Ana');
    // El lock por paciente se pidió (CA6.8).
    expect(prisma.__locks).toContain(`asepsico:process-opening:${WS}:pat-1`);
  });

  it('CA6.5 ADMIN que lo abre a otro profesional con código: aviso al titular y SIN revisión de 72 h', async () => {
    const prisma = seed();
    await new ClinicalProcessesService(prisma).create(WS, ADMIN, { patientId: 'pat-1', title: 'Proceso', therapistId: 't-b', openingReasonCode: 'TRANSFER_ON_LEAVE' } as any);
    const audit = store(prisma).auditLog.find((row: any) => row.action === 'CLINICAL_PROCESS_OPENED_OVER_HISTORY');
    expect(audit.metadata).toEqual({ reasonCode: 'TRANSFER_ON_LEAVE', targetTherapistId: 't-b', selfAssigned: false });
    expect(store(prisma).clinicalProcessOpening[0]).toMatchObject({ selfAssigned: false, ownerReviewDueAt: null });
    expect(store(prisma).notification.map((n: any) => n.userId)).toEqual(['t-a']);
  });

  it.each([
    ['paciente nuevo', 'pat-new'],
    ['paciente con procesos solo del mismo profesional', 'pat-own'],
  ])('CA6.4 %s: flujo de hoy, sin código, sin aviso ni registro de apertura', async (_l, patientId) => {
    const prisma = seed();
    const before = processesOf(prisma, patientId).length;
    await new ClinicalProcessesService(prisma).create(WS, T_B, { patientId, title: 'Proceso' } as any);
    expect(processesOf(prisma, patientId)).toHaveLength(before + 1);
    expect(processesOf(prisma, patientId).at(-1).openingReasonCode).toBeNull();
    expect(store(prisma).clinicalProcessOpening).toHaveLength(0);
    expect(store(prisma).notification).toHaveLength(0);
    expect(store(prisma).auditLog.map((row: any) => row.action)).toEqual(['CLINICAL_PROCESS_CREATED']);
  });

  it('CA6.8 dos aperturas sobre un paciente sin historia: la segunda ya ve la primera (403 THERAPIST / 400 OWNER sin código)', async () => {
    const prisma = seed();
    const service = new ClinicalProcessesService(prisma);
    await service.create(WS, T_B, { patientId: 'pat-new', title: 'Proceso' } as any);
    await expectRejected(() => service.create(WS, T_A, { patientId: 'pat-new', title: 'Proceso' } as any), ForbiddenException, 'PATIENT_HAS_FOREIGN_HISTORY');
    await expectRejected(() => service.create(WS, OWNER_C, { patientId: 'pat-new', title: 'Proceso', therapistId: 't-a' } as any), BadRequestException, 'OPENING_REASON_REQUIRED');
    expect(processesOf(prisma, 'pat-new')).toHaveLength(1);
    // El lock se pide en cada intento, antes de leer la historia.
    expect(prisma.__locks.filter((key: string) => key.endsWith(':pat-new'))).toHaveLength(3);
    const lockOrder = prisma.$executeRawUnsafe.mock.invocationCallOrder[0];
    const firstHistoryRead = prisma.clinicalProcess.findFirst.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(firstHistoryRead);
  });

  it('CA6.9 paciente de otro workspace → 404 y no se crea nada', async () => {
    const prisma = seed();
    await expectRejected(() => new ClinicalProcessesService(prisma).create(WS, OWNER_C, { patientId: 'pat-x', title: 'Proceso', therapistId: 'owner-c', openingReasonCode: 'REFERRAL' } as any), NotFoundException);
    expect(processesOf(prisma, 'pat-x')).toHaveLength(1);
    expect(store(prisma).clinicalProcessOpening).toHaveLength(0);
  });

  it('CA6.9 reactivar un proceso de otro workspace → 404', async () => {
    const prisma = seed();
    await expectRejected(() => new ClinicalProcessesService(prisma).changeStatus(WS, OWNER_C, 'proc-x', 'ACTIVE', { openingReasonCode: 'REFERRAL' }), NotFoundException);
  });
});

describe('H6 · reactivación (CA6.7)', () => {
  const statusOf = (prisma: any, id: string) => store(prisma).clinicalProcess.find((row: any) => row.id === id).status;

  it('THERAPIST que reactiva su proceso con un proceso posterior de otro autor → 403 auditado, sin cambiar el estado', async () => {
    const prisma = seed();
    await expectRejected(() => new ClinicalProcessesService(prisma).changeStatus(WS, T_B, 'proc-r1', 'ACTIVE'), ForbiddenException, 'PATIENT_HAS_FOREIGN_HISTORY');
    expect(statusOf(prisma, 'proc-r1')).toBe('DISCHARGED');
    expect(store(prisma).auditLog).toEqual([expect.objectContaining({ action: 'CLINICAL_ACCESS_DENIED', entityId: 'pat-r', metadata: expect.objectContaining({ reason: 'FOREIGN_HISTORY' }) })]);
    expect(store(prisma).notification).toHaveLength(0);
  });

  it('OWNER sin código → 400 OPENING_REASON_REQUIRED, sin cambios', async () => {
    const prisma = seed();
    await expectRejected(() => new ClinicalProcessesService(prisma).changeStatus(WS, OWNER_C, 'proc-r1', 'ACTIVE'), BadRequestException, 'OPENING_REASON_REQUIRED');
    expect(statusOf(prisma, 'proc-r1')).toBe('DISCHARGED');
    expect(store(prisma).auditLog).toHaveLength(0);
  });

  it('OWNER con código: reactiva, audita solo códigos y avisa al autor posterior; no es autoasignación', async () => {
    const prisma = seed();
    await new ClinicalProcessesService(prisma).changeStatus(WS, OWNER_C, 'proc-r1', 'ACTIVE', { openingReasonCode: 'PATIENT_REQUESTED_CHANGE' });
    expect(statusOf(prisma, 'proc-r1')).toBe('ACTIVE');
    const audit = store(prisma).auditLog.find((row: any) => row.action === 'CLINICAL_PROCESS_OPENED_OVER_HISTORY');
    expect(audit.metadata).toEqual({ reasonCode: 'PATIENT_REQUESTED_CHANGE', targetTherapistId: 't-b', selfAssigned: false });
    expect(store(prisma).clinicalProcessOpening[0]).toMatchObject({ kind: 'REACTIVATED', ownerReviewDueAt: null });
    expect(store(prisma).notification.map((n: any) => n.userId)).toEqual(['t-a']);
  });

  it('sin procesos POSTERIORES de otros autores, la reactivación es la de hoy (también para el THERAPIST)', async () => {
    const prisma = seed();
    await new ClinicalProcessesService(prisma).changeStatus(WS, T_B, 'proc-e2', 'ACTIVE');
    expect(statusOf(prisma, 'proc-e2')).toBe('ACTIVE');
    expect(store(prisma).clinicalProcessOpening).toHaveLength(0);
    expect(store(prisma).notification).toHaveLength(0);
  });

  it('pausar o dar de alta no pasa por la regla (no hay apertura)', async () => {
    const prisma = seed();
    await new ClinicalProcessesService(prisma).changeStatus(WS, T_A, 'proc-r2', 'PAUSED');
    expect(statusOf(prisma, 'proc-r2')).toBe('PAUSED');
    // Sin lock de apertura (los de la agenda, booking: y schedule:, los toma siempre el cierre).
    expect(prisma.__locks.filter((k: string) => k.includes('process-opening'))).toHaveLength(0);
  });
});

describe('H6 · CA6.10 no hay otra ruta de apertura', () => {
  it('completeExistingPatient (importación) nunca crea ni reactiva procesos', async () => {
    const tx: any = {
      patient: { updateMany: jest.fn(async () => ({ count: 1 })) },
      clinicalProcess: { create: jest.fn(), createMany: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    await completeExistingPatient(tx, WS, T_B, 'job-1', 'pat-1', { email: 'nuevo@example.com', phone: '600000000', birthDate: '1990-01-01' } as any);
    expect(tx.clinicalProcess.create).not.toHaveBeenCalled();
    expect(tx.clinicalProcess.createMany).not.toHaveBeenCalled();
    expect(tx.clinicalProcess.updateMany).not.toHaveBeenCalled();
    expect(tx.clinicalProcess.upsert).not.toHaveBeenCalled();
  });

  it('en src/ solo ClinicalProcessesService y el alta de pacientes NUEVOS de la importación crean procesos, y solo changeStatus pasa uno a ACTIVE', () => {
    const { execSync } = require('child_process');
    const root = `${__dirname}/../src`;
    const creates = execSync(`grep -rlE "clinicalProcess\\.(create|createMany|upsert)\\(" ${root} || true`).toString().trim().split('\n').filter(Boolean).map((f: string) => f.replace(`${root}/`, '')).sort();
    expect(creates).toEqual(['clinical-processes/clinical-processes.service.ts', 'patient-import/patient-import-writes.ts']);
    const activations = execSync(`grep -rnE "status: *'ACTIVE'" ${root} | grep -E "data:" || true`).toString().trim();
    expect(activations).toBe('');
  });
});
