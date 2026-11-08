import * as staffRole from '../src/common/auth/assert-staff-role';
import { SessionsController } from '../src/sessions/sessions.controller';
import { SessionsService } from '../src/sessions/sessions.service';
import { PatientAgendaService } from '../src/sessions/patient-agenda.service';
import { encryptField } from '../src/common/crypto/field-encryption';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Regresión de #59 (pendiente de Argos, 08/11): recorre TODOS los endpoints de sesión que
 * responden a recepción (ASSISTANT) a través del controlador y comprueba que el JSON no lleva ni
 * la clave "clinicalProcessId" ni la relación "clinicalProcess":
 *   GET /sessions (con y sin ?patientId=), GET /sessions/:id, POST /sessions, PATCH /sessions/:id,
 *   PATCH /sessions/:id/reschedule, PATCH /sessions/:id/close y GET /sessions/patient/:id/agenda.
 * Además: un rol desconocido ('FOO') nunca recibe datos del proceso (falla en cerrado), y ASSISTANT
 * no puede crear una cita con el id de un proceso de alta, de otro paciente o de otro espacio.
 * Datos 100 % ficticios.
 */

const WS = 'ws-1';
const WS2 = 'ws-2';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE = Math.ceil(Date.now() / HOUR) * HOUR;
const at = (days: number, hours = 10) => new Date(BASE + days * DAY + hours * HOUR);
const plus = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
const body = (startsAt: Date, endsAt = plus(startsAt, 50)) => ({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });

const PROCESS_IDS = ['proc-a', 'proc-discharged', 'proc-other-patient', 'proc-ws2'];
const MARK = { title: 'MARK-TITULO-PROCESO-RECEPCION', notes: 'MARK-NOTAS-SESION-RECEPCION' };

const actor = (sub: string, role: string, workspaceId = WS) => ({ sub, role, workspaceId, email: `${sub}@example.com` }) as any;
const assistant = () => actor('assistant', 'ASSISTANT');

function seed() {
  const member = (userId: string, role: string, isClinician: boolean, workspaceId = WS) => ({ id: `m-${userId}`, workspaceId, userId, role, isClinician });
  const proc = (id: string, patientId: string, status: string, workspaceId = WS, therapistId = 't-a') => ({
    id, workspaceId, patientId, therapistId, status, title: MARK.title, consultationReason: null, goals: null, internalNotes: null,
    modality: 'HYBRID', frequency: 'BIWEEKLY', startedAt: new Date('2026-01-01'), endedAt: status === 'ACTIVE' ? null : new Date('2026-03-01'),
    pausedAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  });
  const ses = (id: string, clinicalProcessId: string | null, startsAt: Date, more: Record<string, unknown> = {}) => ({
    id, workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', clinicalProcessId, startsAt, endsAt: plus(startsAt, 50),
    status: 'SCHEDULED', type: 'INDIVIDUAL', location: 'Sala ficticia', videoCallUrl: null,
    notes: encryptField(MARK.notes), internalSummary: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...more,
  });
  return fakeClinicalDb({
    workspace: [{ id: WS, timeZone: 'Europe/Madrid' }, { id: WS2, timeZone: 'Europe/Madrid' }],
    workspaceMember: [
      member('t-a', 'THERAPIST', true), member('assistant', 'ASSISTANT', false), member('owner', 'OWNER', false),
      member('t-ws2', 'THERAPIST', true, WS2),
    ],
    patient: [
      { id: 'pat-1', workspaceId: WS, firstName: 'Paciente', lastName: 'Ficticio', status: 'ACTIVE', deletedAt: null },
      { id: 'pat-2', workspaceId: WS, firstName: 'Otra', lastName: 'Ficticia', status: 'ACTIVE', deletedAt: null },
      { id: 'pat-ws2', workspaceId: WS2, firstName: 'Ajeno', lastName: 'Ficticio', status: 'ACTIVE', deletedAt: null },
    ],
    clinicalProcess: [
      proc('proc-a', 'pat-1', 'ACTIVE'),
      proc('proc-discharged', 'pat-1', 'DISCHARGED'),
      proc('proc-other-patient', 'pat-2', 'ACTIVE'),
      proc('proc-ws2', 'pat-ws2', 'ACTIVE', WS2, 't-ws2'),
    ],
    session: [
      ses('ses-1', 'proc-a', at(3)),
      ses('ses-close', 'proc-a', at(4)),
      ses('ses-old', 'proc-discharged', at(-200), { status: 'COMPLETED' }),
      ses('ses-free', null, at(6), { location: 'Sala 2' }),
    ],
  } as any);
}

function controller(prisma: any) {
  return new SessionsController(new SessionsService(prisma), new PatientAgendaService(prisma));
}

/** El JSON de recepción: ni la clave clinicalProcessId, ni la relación clinicalProcess, ni ids ni campos del proceso. */
function expectReceptionJson(value: unknown) {
  const out = JSON.stringify(value);
  expect(out).not.toContain('"clinicalProcessId"');
  expect(out).not.toContain('"clinicalProcess"');
  for (const id of PROCESS_IDS) expect(out).not.toContain(id);
  for (const marker of [MARK.title, MARK.notes, 'HYBRID', 'BIWEEKLY']) expect(out).not.toContain(marker);
  for (const key of ['notes', 'internalSummary', 'title', 'modality', 'frequency']) expect(out).not.toContain(`"${key}"`);
  expect(out).not.toMatch(/enc:v[12]:/);
}

/** Una cita de recepción: sin las dos claves a nivel de objeto y con el booleano hasClinicalProcess. */
function expectReceptionSession(row: any, hasProcess: boolean) {
  expect(row).not.toHaveProperty('clinicalProcessId');
  expect(row).not.toHaveProperty('clinicalProcess');
  expect(row.hasClinicalProcess).toBe(hasProcess);
}

const sessionCount = (prisma: any) => prisma.__store.session.length;
const audits = (prisma: any, action: string) => prisma.__store.auditLog.filter((row: any) => row.action === action);
const statusOf = (error: any) => error?.getStatus?.();

// -----------------------------------------------------------------------------------------------
describe('Recepción (ASSISTANT): ningún endpoint de sesión devuelve clinicalProcessId ni clinicalProcess', () => {
  it.each([
    ['GET /sessions', {}],
    ['GET /sessions?patientId=pat-1', { patientId: 'pat-1' }],
  ] as const)('%s', async (_label, query) => {
    const result: any = await controller(seed()).list(assistant(), { ...query } as any);
    expect(result.data.map((row: any) => row.id).sort()).toEqual(['ses-1', 'ses-close', 'ses-free', 'ses-old']);
    for (const row of result.data) expectReceptionSession(row, row.id !== 'ses-free');
    expectReceptionJson(result);
  });

  it.each([['ses-1', true], ['ses-free', false]] as const)('GET /sessions/%s', async (id, hasProcess) => {
    const result: any = await controller(seed()).get(assistant(), id);
    expect(result.id).toBe(id);
    expectReceptionSession(result, hasProcess);
    expectReceptionJson(result);
  });

  it('POST /sessions (con el proceso activo del paciente): la respuesta no lleva el id del proceso, aunque se acaba de enviar', async () => {
    const prisma = seed();
    const start = at(10);
    const result: any = await controller(prisma).create(assistant(), {
      patientId: 'pat-1', clinicalProcessId: 'proc-a', therapistId: 't-a', ...body(start),
    } as any);
    expect(sessionCount(prisma)).toBe(5);
    const created = prisma.__store.session.find((row: any) => row.id === result.id);
    expect(created.clinicalProcessId).toBe('proc-a'); // la cita sí queda asociada al proceso en BD
    expect(new Date(result.startsAt)).toEqual(start);
    expectReceptionSession(result, true);
    expectReceptionJson(result);
  });

  it('PATCH /sessions/:id (heredado): la respuesta de la cita movida es la vista de recepción', async () => {
    const prisma = seed();
    const target = at(12);
    const result: any = await controller(prisma).reschedule(assistant(), 'ses-1', body(target) as any);
    expect(new Date(result.startsAt)).toEqual(target);
    expect(audits(prisma, 'SESSION_RESCHEDULED')).toHaveLength(1);
    expectReceptionSession(result, true);
    expectReceptionJson(result);
  });

  it('PATCH /sessions/:id/reschedule: la respuesta de la cita movida es la vista de recepción', async () => {
    const prisma = seed();
    const target = at(13);
    const result: any = await controller(prisma).move(assistant(), 'ses-1', body(target) as any);
    expect(new Date(result.startsAt)).toEqual(target);
    expect(audits(prisma, 'SESSION_RESCHEDULED')).toHaveLength(1);
    expectReceptionSession(result, true);
    expectReceptionJson(result);
  });

  it.each(['CANCELLED', 'NO_SHOW', 'COMPLETED'] as const)('PATCH /sessions/:id/close (%s): la respuesta es la vista de recepción', async (status) => {
    const prisma = seed();
    const result: any = await controller(prisma).close(assistant(), 'ses-close', { status } as any);
    expect(result.status).toBe(status);
    expect(audits(prisma, 'SESSION_STATUS_CHANGED')).toHaveLength(1);
    expectReceptionSession(result, true);
    expectReceptionJson(result);
  });

  it('PATCH /sessions/:id/close de una cita sin proceso: hasClinicalProcess=false y nada del proceso', async () => {
    const result: any = await controller(seed()).close(assistant(), 'ses-free', { status: 'CANCELLED' } as any);
    expectReceptionSession(result, false);
    expectReceptionJson(result);
  });

  it('GET /sessions/patient/:id/agenda: citas y próxima cita sin el proceso', async () => {
    const result: any = await controller(seed()).patientAgenda(assistant(), 'pat-1', {} as any);
    expect(result.data.length).toBeGreaterThan(0);
    for (const row of result.data) expectReceptionSession(row, row.id !== 'ses-free');
    if (result.nextSession) expectReceptionSession(result.nextSession, true);
    expectReceptionJson(result);
  });
});

// -----------------------------------------------------------------------------------------------
describe('Rol desconocido (FOO): falla en cerrado, nunca recibe el proceso clínico', () => {
  const foo = () => actor('foo', 'FOO');

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['list()', (svc: SessionsService) => svc.list(WS, foo(), { patientId: 'pat-1' } as any)],
    ['get()', (svc: SessionsService) => svc.get(WS, foo(), 'ses-1')],
  ] as const)('%s con la guarda de staff real: 403 sin datos', async (_label, call) => {
    const error = await call(new SessionsService(seed())).then(() => null, (e) => e);
    expect(statusOf(error)).toBe(403);
    expect(JSON.stringify(error.getResponse())).not.toContain('proc-a');
  });

  // Defensa en profundidad: si la guarda de staff dejara pasar un rol inesperado (regresión), el
  // servicio sigue sirviendo la vista de recepción, nunca la de clínico ni la administrativa.
  it('list() sin la guarda de staff: FOO recibe la vista de recepción', async () => {
    jest.spyOn(staffRole, 'assertStaffRole').mockImplementation(() => undefined);
    const result: any = await new SessionsService(seed()).list(WS, foo(), { patientId: 'pat-1' } as any);
    expect(staffRole.assertStaffRole).toHaveBeenCalled();
    expect(result.data).toHaveLength(4);
    for (const row of result.data) expectReceptionSession(row, row.id !== 'ses-free');
    expectReceptionJson(result);
  });

  it.each([['ses-1', true], ['ses-free', false]] as const)('get(%s) sin la guarda de staff: FOO recibe la vista de recepción', async (id, hasProcess) => {
    jest.spyOn(staffRole, 'assertStaffRole').mockImplementation(() => undefined);
    const result: any = await new SessionsService(seed()).get(WS, foo(), id);
    expect(staffRole.assertStaffRole).toHaveBeenCalled();
    expect(result.id).toBe(id);
    expectReceptionSession(result, hasProcess);
    expectReceptionJson(result);
  });
});

// -----------------------------------------------------------------------------------------------
describe('POST /sessions de ASSISTANT con un proceso que no vale: 400/403 sin crear nada', () => {
  it.each([
    ['un proceso de alta del paciente', 'proc-discharged'],
    ['el proceso de otro paciente del mismo espacio', 'proc-other-patient'],
    ['el proceso de otro espacio', 'proc-ws2'],
    ['un id inexistente', 'proc-no-existe'],
  ] as const)('con %s', async (_label, clinicalProcessId) => {
    const prisma = seed();
    const before = sessionCount(prisma);
    const error = await controller(prisma).create(assistant(), {
      patientId: 'pat-1', clinicalProcessId, therapistId: 't-a', ...body(at(15)),
    } as any).then(() => null, (e) => e);
    expect(error).not.toBeNull();
    expect([400, 403]).toContain(statusOf(error));
    expect(sessionCount(prisma)).toBe(before);
    expect(audits(prisma, 'SESSION_CREATED')).toHaveLength(0);
    expect(prisma.session.create).not.toHaveBeenCalled();
    // El error no confirma datos del proceso (ni título ni modalidad).
    const out = JSON.stringify(error.getResponse());
    for (const marker of [MARK.title, 'HYBRID', 'BIWEEKLY']) expect(out).not.toContain(marker);
  });
});
