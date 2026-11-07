import { PatientAgendaService } from '../src/sessions/patient-agenda.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { encryptField } from '../src/common/crypto/field-encryption';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Regla dura 2: ASSISTANT (recepción) no accede a ClinicalProcess. En la agenda ve cuándo, con
 * quién, tipo de cita, lugar y enlace, pero nada del proceso clínico: ni título, ni modalidad, ni
 * frecuencia, ni estado, ni el clinicalProcessId: solo el booleano hasClinicalProcess. Cubre
 * GET /sessions (también con ?patientId=), GET /sessions/:id (también la respuesta de
 * POST/PATCH/reschedule/close, que reutilizan get) y GET /sessions/patient/:id/agenda.
 * OWNER/ADMIN/THERAPIST conservan los metadatos del proceso que ya tenían. Datos 100 % ficticios.
 */

const WS = 'ws-1';
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.now() + days * DAY);
const MARK = { title: 'MARK-PROCESS-TITLE', notes: 'MARK-SESSION-NOTES' };
const DISCHARGED_ID = 'proc-discharged-marker';

type Role = 'THERAPIST' | 'OWNER' | 'ADMIN' | 'ASSISTANT';
const actor = (sub: string, role: Role) => ({ sub, role, workspaceId: WS, email: `${sub}@example.com` }) as any;

function seed() {
  const member = (userId: string, role: Role, isClinician: boolean) => ({ id: `m-${userId}`, workspaceId: WS, userId, role, isClinician });
  return fakeClinicalDb({
    workspaceMember: [member('t-a', 'THERAPIST', true), member('owner', 'OWNER', false), member('admin', 'ADMIN', false), member('assistant', 'ASSISTANT', false)],
    patient: [{ id: 'pat-1', workspaceId: WS, firstName: 'Paciente', lastName: 'Ficticio', status: 'ACTIVE', deletedAt: null }],
    clinicalProcess: [{
      id: 'proc-a', workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', status: 'ACTIVE', title: MARK.title,
      consultationReason: null, goals: null, internalNotes: null, modality: 'HYBRID', frequency: 'BIWEEKLY',
      startedAt: new Date('2026-01-01'), endedAt: null, pausedAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    }, {
      // Proceso de alta: su id no debe llegar nunca a recepción.
      id: DISCHARGED_ID, workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', status: 'DISCHARGED', title: MARK.title,
      consultationReason: null, goals: null, internalNotes: null, modality: 'HYBRID', frequency: 'BIWEEKLY',
      startedAt: new Date('2025-01-01'), endedAt: new Date('2025-06-01'), pausedAt: null, createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-06-01'),
    }],
    session: [{
      id: 'ses-1', workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', clinicalProcessId: 'proc-a', startsAt: at(2),
      endsAt: new Date(at(2).getTime() + 50 * 60 * 1000), status: 'SCHEDULED', type: 'INDIVIDUAL', location: 'Sala 1',
      videoCallUrl: null, notes: encryptField(MARK.notes), internalSummary: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    }, {
      id: 'ses-old', workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', clinicalProcessId: DISCHARGED_ID, startsAt: at(-200),
      endsAt: new Date(at(-200).getTime() + 50 * 60 * 1000), status: 'COMPLETED', type: 'INDIVIDUAL', location: 'Sala 1',
      videoCallUrl: null, notes: encryptField(MARK.notes), internalSummary: null, createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-01'),
    }, {
      // Cita sin proceso clínico asociado (p. ej. primera visita).
      id: 'ses-free', workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', clinicalProcessId: null, startsAt: at(5),
      endsAt: new Date(at(5).getTime() + 50 * 60 * 1000), status: 'SCHEDULED', type: 'INDIVIDUAL', location: 'Sala 2',
      videoCallUrl: null, notes: null, internalSummary: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    }],
  });
}

const json = (value: unknown) => JSON.stringify(value);
/** Nada del proceso clínico: ni la relación, ni sus campos, ni sus valores. */
const expectNoProcessData = (value: unknown) => {
  const out = json(value);
  expect(out).not.toContain('"clinicalProcess"');
  for (const key of ['title', 'modality', 'frequency', 'notes', 'internalSummary', 'consultationReason', 'goals', 'internalNotes']) {
    expect(out).not.toContain(`"${key}"`);
  }
  for (const marker of [MARK.title, MARK.notes, 'HYBRID', 'BIWEEKLY']) expect(out).not.toContain(marker);
  expect(out).not.toMatch(/enc:v[12]:/);
  // Ni el id del proceso: ni la clave clinicalProcessId ni los ids (activo o de alta).
  expect(out).not.toContain('"clinicalProcessId"');
  for (const id of ['proc-a', DISCHARGED_ID]) expect(out).not.toContain(id);
};
/** hasClinicalProcess correcto en cada cita de recepción (con y sin proceso). */
const EXPECTED_HAS_PROCESS: Record<string, boolean> = { 'ses-1': true, 'ses-old': true, 'ses-free': false };
const expectHasProcessFlags = (rows: any[]) => {
  expect(rows.map((row) => row.id).sort()).toEqual(['ses-1', 'ses-free', 'ses-old']);
  for (const row of rows) expect(row.hasClinicalProcess).toBe(EXPECTED_HAS_PROCESS[row.id]);
};

describe('Agenda de recepción (ASSISTANT): sin datos del proceso clínico', () => {
  it.each([['sin filtro', {}], ['?patientId=', { patientId: 'pat-1' }]] as const)(
    'GET /sessions (%s): ASSISTANT recibe las citas sin clinicalProcess ni clinicalProcessId, con hasClinicalProcess', async (_label, query) => {
      const result: any = await new SessionsService(seed() as any).list(WS, actor('assistant', 'ASSISTANT'), { ...query } as any);
      expectHasProcessFlags(result.data);
      const row = result.data.find((item: any) => item.id === 'ses-1');
      expect(row.patient).toEqual({ id: 'pat-1', firstName: 'Paciente', lastName: 'Ficticio' });
      expect(row.therapist.id).toBe('t-a');
      expect(row.location).toBe('Sala 1');
      for (const item of result.data) {
        expect(item).not.toHaveProperty('clinicalProcess');
        expect(item).not.toHaveProperty('clinicalProcessId');
      }
      expect(result.meta.total).toBe(3);
      expectNoProcessData(result);
    });

  it.each([['ses-1', true], ['ses-free', false]] as const)(
    'GET /sessions/:id (%s): ASSISTANT recibe el detalle sin clinicalProcess ni su id', async (id, hasProcess) => {
      const result: any = await new SessionsService(seed() as any).get(WS, actor('assistant', 'ASSISTANT'), id);
      expect(result.id).toBe(id);
      expect(result.hasClinicalProcess).toBe(hasProcess);
      expect(result).not.toHaveProperty('clinicalProcess');
      expect(result).not.toHaveProperty('clinicalProcessId');
      expectNoProcessData(result);
    });

  it('GET /sessions/patient/:id/agenda: ASSISTANT recibe las citas sin clinicalProcess ni su id', async () => {
    const result: any = await new PatientAgendaService(seed() as any).agenda(WS, actor('assistant', 'ASSISTANT'), 'pat-1');
    expect(result.view).toBe('ADMINISTRATIVE');
    expectHasProcessFlags(result.data);
    for (const item of result.data) {
      expect(item).not.toHaveProperty('clinicalProcess');
      expect(item).not.toHaveProperty('clinicalProcessId');
      expect(item.visibility).toBe('FULL');
    }
    expect(result.nextSession.id).toBe('ses-1');
    expect(result.nextSession.hasClinicalProcess).toBe(true);
    expect(result.nextSession).not.toHaveProperty('clinicalProcess');
    expect(result.nextSession).not.toHaveProperty('clinicalProcessId');
    expectNoProcessData(result);
  });

  it.each([['owner', 'OWNER'], ['admin', 'ADMIN'], ['t-a', 'THERAPIST']] as const)(
    'GET /sessions: %s conserva clinicalProcessId y no recibe hasClinicalProcess', async (sub, role) => {
      const result: any = await new SessionsService(seed() as any).list(WS, actor(sub, role), { patientId: 'pat-1' } as any);
      const byId = Object.fromEntries(result.data.map((row: any) => [row.id, row]));
      expect(byId['ses-1'].clinicalProcessId).toBe('proc-a');
      expect(byId['ses-old'].clinicalProcessId).toBe(DISCHARGED_ID);
      expect(byId['ses-free'].clinicalProcessId).toBeNull();
      for (const row of result.data) expect(row).not.toHaveProperty('hasClinicalProcess');
    });

  it.each([['owner', 'OWNER'], ['admin', 'ADMIN']] as const)(
    'GET /sessions/patient/:id/agenda: %s conserva clinicalProcessId', async (sub, role) => {
      const result: any = await new PatientAgendaService(seed() as any).agenda(WS, actor(sub, role), 'pat-1');
      const row = result.data.find((item: any) => item.id === 'ses-1');
      expect(row.clinicalProcessId).toBe('proc-a');
      expect(row).not.toHaveProperty('hasClinicalProcess');
    });

  it.each([['owner', 'OWNER'], ['admin', 'ADMIN'], ['t-a', 'THERAPIST']] as const)(
    'GET /sessions: %s conserva modalidad y estado del proceso, nunca el título', async (sub, role) => {
      const result: any = await new SessionsService(seed() as any).list(WS, actor(sub, role), {} as any);
      expect(result.data.find((row: any) => row.id === 'ses-1').clinicalProcess).toEqual({ id: 'proc-a', modality: 'HYBRID', status: 'ACTIVE' });
      expect(json(result)).not.toContain(MARK.title);
      expect(json(result)).not.toContain('"title"');
    });

  it.each([['owner', 'OWNER'], ['admin', 'ADMIN']] as const)(
    'GET /sessions/patient/:id/agenda: %s conserva modalidad y estado del proceso', async (sub, role) => {
      const result: any = await new PatientAgendaService(seed() as any).agenda(WS, actor(sub, role), 'pat-1');
      expect(result.data.find((row: any) => row.id === 'ses-1').clinicalProcess).toEqual({ id: 'proc-a', modality: 'HYBRID', status: 'ACTIVE' });
    });
});
