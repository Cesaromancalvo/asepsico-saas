import { PatientAgendaService } from '../src/sessions/patient-agenda.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { encryptField } from '../src/common/crypto/field-encryption';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Regla dura 2: ASSISTANT (recepción) no accede a ClinicalProcess. En la agenda ve cuándo, con
 * quién, tipo de cita, lugar y enlace, pero nada del proceso clínico: ni título, ni modalidad, ni
 * frecuencia, ni estado. Cubre GET /sessions, GET /sessions/:id (también la respuesta de
 * POST/PATCH, que reutiliza get) y GET /sessions/patient/:id/agenda. OWNER/ADMIN/THERAPIST
 * conservan los metadatos del proceso que ya tenían. Datos 100 % ficticios.
 */

const WS = 'ws-1';
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.now() + days * DAY);
const MARK = { title: 'MARK-PROCESS-TITLE', notes: 'MARK-SESSION-NOTES' };

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
    }],
    session: [{
      id: 'ses-1', workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', clinicalProcessId: 'proc-a', startsAt: at(2),
      endsAt: new Date(at(2).getTime() + 50 * 60 * 1000), status: 'SCHEDULED', type: 'INDIVIDUAL', location: 'Sala 1',
      videoCallUrl: null, notes: encryptField(MARK.notes), internalSummary: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
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
};

describe('Agenda de recepción (ASSISTANT): sin datos del proceso clínico', () => {
  it('GET /sessions: ASSISTANT recibe la cita sin clinicalProcess (ni modalidad ni estado del proceso)', async () => {
    const result: any = await new SessionsService(seed() as any).list(WS, actor('assistant', 'ASSISTANT'), {} as any);
    expect(result.data).toHaveLength(1);
    const row = result.data[0];
    expect(row.id).toBe('ses-1');
    expect(row.clinicalProcessId).toBe('proc-a');
    expect(row.patient).toEqual({ id: 'pat-1', firstName: 'Paciente', lastName: 'Ficticio' });
    expect(row.therapist.id).toBe('t-a');
    expect(row.location).toBe('Sala 1');
    expect(row).not.toHaveProperty('clinicalProcess');
    expectNoProcessData(result);
  });

  it('GET /sessions/:id: ASSISTANT recibe el detalle sin clinicalProcess', async () => {
    const result: any = await new SessionsService(seed() as any).get(WS, actor('assistant', 'ASSISTANT'), 'ses-1');
    expect(result.id).toBe('ses-1');
    expect(result).not.toHaveProperty('clinicalProcess');
    expectNoProcessData(result);
  });

  it('GET /sessions/patient/:id/agenda: ASSISTANT recibe las citas sin clinicalProcess', async () => {
    const result: any = await new PatientAgendaService(seed() as any).agenda(WS, actor('assistant', 'ASSISTANT'), 'pat-1');
    expect(result.view).toBe('ADMINISTRATIVE');
    expect(result.data.map((item: any) => item.id)).toEqual(['ses-1']);
    expect(result.data[0]).not.toHaveProperty('clinicalProcess');
    expect(result.nextSession).not.toHaveProperty('clinicalProcess');
    expectNoProcessData(result);
  });

  it.each([['owner', 'OWNER'], ['admin', 'ADMIN'], ['t-a', 'THERAPIST']] as const)(
    'GET /sessions: %s conserva modalidad y estado del proceso, nunca el título', async (sub, role) => {
      const result: any = await new SessionsService(seed() as any).list(WS, actor(sub, role), {} as any);
      expect(result.data[0].clinicalProcess).toEqual({ id: 'proc-a', modality: 'HYBRID', status: 'ACTIVE' });
      expect(json(result)).not.toContain(MARK.title);
      expect(json(result)).not.toContain('"title"');
    });

  it.each([['owner', 'OWNER'], ['admin', 'ADMIN']] as const)(
    'GET /sessions/patient/:id/agenda: %s conserva modalidad y estado del proceso', async (sub, role) => {
      const result: any = await new PatientAgendaService(seed() as any).agenda(WS, actor(sub, role), 'pat-1');
      expect(result.data[0].clinicalProcess).toEqual({ id: 'proc-a', modality: 'HYBRID', status: 'ACTIVE' });
    });
});
