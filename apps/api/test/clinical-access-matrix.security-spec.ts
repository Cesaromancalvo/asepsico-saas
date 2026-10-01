import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { hashSync } from 'bcryptjs';
import { PatientsService } from '../src/patients/patients.service';
import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { MessagesService } from '../src/messages/messages.service';
import { ExportsService } from '../src/exports/exports.service';
import { encryptField } from '../src/common/crypto/field-encryption';
import { encryptAssessmentResult, encryptJsonField } from '../src/common/crypto/clinical-crypto';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Matriz de acceso al contenido clínico (rol × relación con el paciente × tipo de contenido).
 *
 * Regla: el contenido clínico solo lo ve un profesional clínico (isClinician) con proceso ACTIVO
 * con el paciente; el autor de un proceso cerrado conserva la LECTURA de lo suyo. OWNER/ADMIN por
 * serlo no ven nada clínico; ASSISTANT nunca. Notas internas: solo su autor. Mensajes: solo los
 * del tratamiento de cada profesional. Los intentos denegados se auditan.
 *
 * Base de datos en memoria que aplica los filtros (support/fake-clinical-db.ts). Cada contenido
 * lleva un marcador único para comprobar exactamente qué sale en cada respuesta.
 * Datos 100 % ficticios.
 */

const WS = 'ws-1';
const PASSWORD = 'contrasena-ficticia-de-test';
const PASSWORD_HASH = hashSync(PASSWORD, 4);

type ActorKey =
  | 't-active' | 'owner-c' | 't-closed' | 't-other' | 't-none' | 'owner-flagoff'
  | 'owner-nc' | 'admin-nc' | 'admin-c-none' | 'assistant';

const MEMBERS: Record<ActorKey, { role: string; isClinician: boolean; label: string }> = {
  't-active': { role: 'THERAPIST', isClinician: true, label: 'THERAPIST con proceso ACTIVO' },
  'owner-c': { role: 'OWNER', isClinician: true, label: 'OWNER clínico con proceso ACTIVO' },
  't-closed': { role: 'THERAPIST', isClinician: true, label: 'THERAPIST autor de un proceso CERRADO' },
  't-other': { role: 'THERAPIST', isClinician: true, label: 'THERAPIST con proceso con OTRO paciente' },
  't-none': { role: 'THERAPIST', isClinician: true, label: 'THERAPIST clínico SIN proceso' },
  'owner-flagoff': { role: 'OWNER', isClinician: false, label: 'OWNER NO clínico con proceso ACTIVO' },
  'owner-nc': { role: 'OWNER', isClinician: false, label: 'OWNER no clínico' },
  'admin-nc': { role: 'ADMIN', isClinician: false, label: 'ADMIN no clínico' },
  'admin-c-none': { role: 'ADMIN', isClinician: true, label: 'ADMIN clínico SIN proceso' },
  assistant: { role: 'ASSISTANT', isClinician: false, label: 'ASSISTANT' },
};

const actor = (key: ActorKey, overrides: Record<string, unknown> = {}) =>
  ({ sub: key, workspaceId: WS, role: MEMBERS[key].role, email: `${key}@example.com`, ...overrides }) as any;

const TREATING: ActorKey[] = ['t-active', 'owner-c'];
const FORMER: ActorKey[] = ['t-closed'];
const DENIED: ActorKey[] = ['t-other', 't-none', 'owner-flagoff', 'owner-nc', 'admin-nc', 'admin-c-none', 'assistant'];
const NOT_TREATING: ActorKey[] = [...FORMER, ...DENIED];

const M = {
  patientReason: 'MARK-PATIENT-REASON', history: 'MARK-HISTORY', goal: 'MARK-GOAL', assessment: 'MARK-ASSESSMENT',
  titleClosed: 'MARK-TITLE-CLOSED', titleActive: 'MARK-TITLE-ACTIVE',
  procReasonClosed: 'MARK-PROC-REASON-CLOSED', procReasonActive: 'MARK-PROC-REASON-ACTIVE',
  internalClosed: 'MARK-INTERNAL-CLOSED', internalActive: 'MARK-INTERNAL-ACTIVE',
  sesNotesClosed: 'MARK-SES-NOTES-CLOSED', sesSummaryClosed: 'MARK-SES-SUMMARY-CLOSED',
  sesNotesActive: 'MARK-SES-NOTES-ACTIVE', sesSummaryActive: 'MARK-SES-SUMMARY-ACTIVE',
  taskClosed: 'MARK-TASK-CLOSED', taskActive: 'MARK-TASK-ACTIVE', taskLoose: 'MARK-TASK-LOOSE',
  reportClosed: 'MARK-REPORT-CLOSED', reportActive: 'MARK-REPORT-ACTIVE',
  docClosed: 'MARK-DOC-CLOSED', docActive: 'MARK-DOC-ACTIVE',
  consentNotes: 'MARK-CONSENT-NOTES', msgOld: 'MARK-MSG-OLD', msgNew: 'MARK-MSG-NEW',
};
const ALL_MARKERS = Object.values(M);

const d = (iso: string) => new Date(iso);
const enc = (text: string) => encryptField(text)!;

function seedDb() {
  const members = (Object.keys(MEMBERS) as ActorKey[]).map((key, i) => ({
    id: `m-${i}`, workspaceId: WS, userId: key, role: MEMBERS[key].role, isClinician: MEMBERS[key].isClinician,
  }));
  const process = (id: string, patientId: string, therapistId: string, status: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id, workspaceId: WS, patientId, therapistId, status, title: `Proceso ${id}`, consultationReason: null, goals: null, internalNotes: null,
    modality: 'IN_PERSON', frequency: 'WEEKLY', startedAt: d(createdAt), endedAt: null, createdAt: d(createdAt), updatedAt: d(createdAt), ...extra,
  });
  const session = (id: string, therapistId: string, clinicalProcessId: string, startsAt: string, notes: string, summary: string) => ({
    id, workspaceId: WS, patientId: 'pat-1', therapistId, clinicalProcessId, startsAt: d(startsAt), endsAt: d(startsAt),
    status: 'COMPLETED', type: 'INDIVIDUAL', location: null, videoCallUrl: null, notes: enc(notes), internalSummary: enc(summary),
    createdAt: d(startsAt), updatedAt: d(startsAt),
  });
  return fakeClinicalDb({
    user: (Object.keys(MEMBERS) as ActorKey[]).map((key) => ({ id: key, passwordHash: PASSWORD_HASH })),
    workspaceMember: members,
    patient: [
      { id: 'pat-1', workspaceId: WS, firstName: 'Paciente', lastName: 'Ficticio', email: 'p@example.com', phone: null, birthDate: null,
        consultationReason: enc(M.patientReason), status: 'ACTIVE', portalAccessMode: 'PATIENT_ONLY', createdAt: d('2025-12-01'),
        updatedAt: d('2025-12-01'), deletedAt: null, blockedAt: null, retentionUntil: null },
      { id: 'pat-2', workspaceId: WS, firstName: 'Otro', lastName: 'Ficticio', consultationReason: null, status: 'ACTIVE', deletedAt: null, createdAt: d('2025-12-01') },
    ],
    clinicalProcess: [
      process('proc-closed', 'pat-1', 't-closed', 'CLOSED', '2026-01-01T00:00:00Z', {
        title: M.titleClosed, consultationReason: enc(M.procReasonClosed), internalNotes: enc(M.internalClosed), endedAt: d('2026-03-01T00:00:00Z'), updatedAt: d('2026-03-01T00:00:00Z'),
      }),
      process('proc-active', 'pat-1', 't-active', 'ACTIVE', '2026-04-01T00:00:00Z', {
        title: M.titleActive, consultationReason: enc(M.procReasonActive), internalNotes: enc(M.internalActive),
      }),
      process('proc-owner', 'pat-1', 'owner-c', 'ACTIVE', '2026-04-01T00:00:00Z'),
      process('proc-flagoff', 'pat-1', 'owner-flagoff', 'ACTIVE', '2026-04-01T00:00:00Z'),
      process('proc-other', 'pat-2', 't-other', 'ACTIVE', '2026-01-01T00:00:00Z'),
    ],
    session: [
      session('ses-closed', 't-closed', 'proc-closed', '2026-02-01T10:00:00Z', M.sesNotesClosed, M.sesSummaryClosed),
      session('ses-active', 't-active', 'proc-active', '2026-04-05T10:00:00Z', M.sesNotesActive, M.sesSummaryActive),
    ],
    clinicalHistory: [{ id: 'hist-1', patientId: 'pat-1', currentProblem: enc(M.history), createdAt: d('2026-01-01'), updatedAt: d('2026-01-02') }],
    therapyGoal: [{ id: 'goal-1', patientId: 'pat-1', title: enc(M.goal), description: null, status: 'ACTIVE', priority: 1, createdAt: d('2026-01-01'), updatedAt: d('2026-01-01'), achievedAt: null }],
    therapeuticTask: [
      { id: 'task-closed', patientId: 'pat-1', sessionId: 'ses-closed', therapyGoalId: null, title: enc(M.taskClosed), instructions: null, status: 'PENDING', createdAt: d('2026-02-01'), updatedAt: d('2026-02-01') },
      { id: 'task-active', patientId: 'pat-1', sessionId: 'ses-active', therapyGoalId: 'goal-1', title: enc(M.taskActive), instructions: null, status: 'PENDING', createdAt: d('2026-04-05'), updatedAt: d('2026-04-05') },
      { id: 'task-loose', patientId: 'pat-1', sessionId: null, therapyGoalId: null, title: enc(M.taskLoose), instructions: null, status: 'PENDING', createdAt: d('2026-04-06'), updatedAt: d('2026-04-06') },
    ],
    clinicalAssessment: [{
      id: 'asm-1', patientId: 'pat-1', scaleCode: 'PHQ9', scaleName: 'PHQ-9', answers: encryptJsonField([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      result: encryptAssessmentResult({ totalScore: 0, severity: 'Mínima', riskFlag: false }), interpretation: enc(M.assessment),
      clinicalNotes: null, administeredAt: d('2026-01-10'), createdAt: d('2026-01-10'), updatedAt: d('2026-01-10'),
    }],
    clinicalReport: [
      { id: 'rep-closed', workspaceId: WS, patientId: 'pat-1', createdById: 't-closed', title: 'Informe', type: 'EVOLUTION', status: 'FINAL', content: enc(M.reportClosed), createdAt: d('2026-02-15'), updatedAt: d('2026-02-15') },
      { id: 'rep-active', workspaceId: WS, patientId: 'pat-1', createdById: 't-active', title: 'Informe', type: 'EVOLUTION', status: 'DRAFT', content: enc(M.reportActive), createdAt: d('2026-04-15'), updatedAt: d('2026-04-15') },
    ],
    patientDocument: [
      { id: 'doc-closed', workspaceId: WS, patientId: 'pat-1', createdById: 't-closed', title: 'Documento', type: 'CLINICAL', description: enc(M.docClosed), fileName: null, createdAt: d('2026-02-15'), updatedAt: d('2026-02-15') },
      { id: 'doc-active', workspaceId: WS, patientId: 'pat-1', createdById: 't-active', title: 'Documento', type: 'CLINICAL', description: enc(M.docActive), fileName: null, createdAt: d('2026-04-15'), updatedAt: d('2026-04-15') },
    ],
    consentRecord: [{ id: 'con-1', workspaceId: WS, patientId: 'pat-1', createdById: 't-closed', type: 'INFORMED_CONSENT', title: 'Consentimiento', status: 'SIGNED', signedAt: d('2026-01-01'), expiresAt: null, signedBy: 'Paciente', notes: enc(M.consentNotes), createdAt: d('2026-01-01'), updatedAt: d('2026-01-01') }],
    conversation: [{ id: 'conv-1', workspaceId: WS, patientId: 'pat-1', status: 'OPEN', patientCanReply: true, closedAt: null, archivedAt: null, createdAt: d('2026-01-05'), updatedAt: d('2026-04-10') }],
    message: [
      { id: 'msg-old', conversationId: 'conv-1', senderType: 'PATIENT', senderUserId: null, body: enc(M.msgOld), attachmentName: null, mimeType: null, createdAt: d('2026-02-10T09:00:00Z'), readByProfessionalAt: null, readByPatientAt: null },
      { id: 'msg-new', conversationId: 'conv-1', senderType: 'PATIENT', senderUserId: null, body: enc(M.msgNew), attachmentName: null, mimeType: null, createdAt: d('2026-04-10T09:00:00Z'), readByProfessionalAt: null, readByPatientAt: null },
    ],
  });
}

const json = (value: unknown) => JSON.stringify(value);
function expectOnly(value: unknown, allowed: string[]) {
  const out = json(value);
  expect(out).not.toMatch(/enc:v[12]:/);
  for (const marker of allowed) expect({ marker, present: out.includes(marker) }).toEqual({ marker, present: true });
  for (const marker of ALL_MARKERS.filter((m) => !allowed.includes(m))) expect({ marker, present: out.includes(marker) }).toEqual({ marker, present: false });
}
async function expectDenied(prisma: any, run: () => Promise<unknown>) {
  await expect(run()).rejects.toBeInstanceOf(ForbiddenException);
  expect(prisma.__store.auditLog).toEqual(expect.arrayContaining([
    expect.objectContaining({ workspaceId: WS, action: 'CLINICAL_ACCESS_DENIED' }),
  ]));
  expect(json(prisma.__store.auditLog)).not.toMatch(/MARK-/);
}

const label = (keys: ActorKey[]) => keys.map((key) => [MEMBERS[key].label, key] as const);

// ------------------------------------------------------------------------------------------
// Contenido NO atribuible a un autor: solo quien trata al paciente.
// ------------------------------------------------------------------------------------------

const PATIENT_LEVEL: Array<[string, (s: PatientsService, a: any) => Promise<unknown>, string]> = [
  ['motivo de consulta', (s, a) => s.getConsultationReason(WS, a, 'pat-1'), M.patientReason],
  ['historia clínica', (s, a) => s.getClinicalHistory(WS, a, 'pat-1'), M.history],
  ['objetivos', (s, a) => s.getTherapyGoals(WS, a, 'pat-1'), M.goal],
  ['escalas', (s, a) => s.getClinicalAssessments(WS, a, 'pat-1'), M.assessment],
];

describe.each(PATIENT_LEVEL)('Contenido del paciente: %s', (_name, run, marker) => {
  it.each(label(TREATING))('%s → lo ve', async (_l, key) => {
    const prisma = seedDb();
    expect(json(await run(new PatientsService(prisma), actor(key)))).toContain(marker);
  });

  it.each(label(NOT_TREATING))('%s → 403 auditado', async (_l, key) => {
    const prisma = seedDb();
    await expectDenied(prisma, () => run(new PatientsService(prisma), actor(key)));
  });
});

describe('Resumen (timeline) del paciente', () => {
  it.each(label(TREATING))('%s → lo ve, sin notas internas', async (_l, key) => {
    const prisma = seedDb();
    const events = await new PatientsService(prisma).getTimeline(WS, actor(key), 'pat-1');
    expect(json(events)).toContain(M.goal);
    expect(json(events)).not.toContain(M.internalClosed);
    expect(json(events)).not.toContain(M.internalActive);
  });

  it.each(label(NOT_TREATING))('%s → 403 auditado', async (_l, key) => {
    const prisma = seedDb();
    await expectDenied(prisma, () => new PatientsService(prisma).getTimeline(WS, actor(key), 'pat-1'));
  });
});

// ------------------------------------------------------------------------------------------
// Contenido atribuible: quien trata ve todo; el autor de un proceso cerrado, solo lo suyo.
// ------------------------------------------------------------------------------------------

const AUTHORED: Array<[string, (s: PatientsService, a: any) => Promise<unknown>, string[], string[]]> = [
  ['tareas', (s, a) => s.getTherapeuticTasks(WS, a, 'pat-1'), [M.taskClosed, M.taskActive, M.taskLoose, M.goal], [M.taskClosed]],
  ['informes', (s, a) => s.getClinicalReports(WS, a, 'pat-1'), [M.reportClosed, M.reportActive], [M.reportClosed]],
  ['documentos', (s, a) => s.getPatientDocuments(WS, a, 'pat-1'), [M.docClosed, M.docActive], [M.docClosed]],
];

describe.each(AUTHORED)('Contenido con autor: %s', (_name, run, treatingSees, formerSees) => {
  it.each(label(TREATING))('%s → todo', async (_l, key) => {
    const prisma = seedDb();
    expectOnly(await run(new PatientsService(prisma), actor(key)), treatingSees);
  });

  it.each(label(FORMER))('%s → solo lo suyo, en lectura', async (_l, key) => {
    const prisma = seedDb();
    expectOnly(await run(new PatientsService(prisma), actor(key)), formerSees);
  });

  it.each(label(DENIED))('%s → 403 auditado', async (_l, key) => {
    const prisma = seedDb();
    await expectDenied(prisma, () => run(new PatientsService(prisma), actor(key)));
  });
});

// ------------------------------------------------------------------------------------------
// Procesos clínicos (detalle, notas internas) y su listado.
// ------------------------------------------------------------------------------------------

describe('GET /clinical-processes/:id', () => {
  it('el autor del proceso activo lo ve completo, con sus notas internas', async () => {
    const result: any = await new ClinicalProcessesService(seedDb()).get(WS, actor('t-active'), 'proc-active');
    expect(result.internalNotes).toBe(M.internalActive);
    expect(result.readOnly).toBe(false);
    expect(json(result)).toContain(M.sesSummaryActive);
    expect(json(result)).not.toContain(M.patientReason);
  });

  it('el autor de un proceso cerrado lo lee (solo lectura), con sus notas internas', async () => {
    const result: any = await new ClinicalProcessesService(seedDb()).get(WS, actor('t-closed'), 'proc-closed');
    expect(result.internalNotes).toBe(M.internalClosed);
    expect(result.readOnly).toBe(true);
    expect(json(result)).toContain(M.sesNotesClosed);
  });

  it('el autor de un proceso cerrado NO lee el proceso activo de otro profesional', async () => {
    const prisma = seedDb();
    await expectDenied(prisma, () => new ClinicalProcessesService(prisma).get(WS, actor('t-closed'), 'proc-active'));
  });

  it.each(label(TREATING))('%s ve el proceso anterior de otro profesional SIN sus notas internas ni resúmenes internos', async (_l, key) => {
    const result: any = await new ClinicalProcessesService(seedDb()).get(WS, actor(key), 'proc-closed');
    expect(result.consultationReason).toBe(M.procReasonClosed);
    expect(result).not.toHaveProperty('internalNotes');
    expect(json(result)).toContain(M.sesNotesClosed);
    expect(json(result)).not.toContain(M.internalClosed);
    expect(json(result)).not.toContain(M.sesSummaryClosed);
    expect(result.readOnly).toBe(true);
  });

  it.each(label(DENIED.filter((k) => k !== 'assistant')))('%s → 403 auditado', async (_l, key) => {
    const prisma = seedDb();
    await expectDenied(prisma, () => new ClinicalProcessesService(prisma).get(WS, actor(key), 'proc-active'));
  });

  it('ASSISTANT → 403', async () => {
    await expect(new ClinicalProcessesService(seedDb()).get(WS, actor('assistant'), 'proc-active')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('GET /clinical-processes (listado administrativo)', () => {
  it.each(label(['owner-nc', 'admin-nc'] as ActorKey[]))('%s ve quién atiende a quién, sin títulos', async (_l, key) => {
    const result: any = await new ClinicalProcessesService(seedDb()).list(WS, actor(key), {} as any);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.every((row: any) => row.title === null && row.canReadClinical === false)).toBe(true);
    expectOnly(result, []);
  });

  it('buscar por título no revela procesos que no puede leer', async () => {
    const prisma = seedDb();
    const result: any = await new ClinicalProcessesService(prisma).list(WS, actor('owner-nc'), { q: 'MARK-TITLE' } as any);
    expect(result.data).toEqual([]);
  });

  it('quien trata al paciente ve los títulos de sus procesos (también los anteriores)', async () => {
    const result: any = await new ClinicalProcessesService(seedDb()).list(WS, actor('t-active'), { patientId: 'pat-1' } as any);
    expect(json(result)).toContain(M.titleActive);
    expect(json(result)).toContain(M.titleClosed);
  });
});

// ------------------------------------------------------------------------------------------
// Sesiones: notas (clínicas) y resumen interno (nota interna del autor).
// ------------------------------------------------------------------------------------------

describe('GET /sessions/:id (sesión del proceso cerrado)', () => {
  it('su autor ve notas y resumen interno', async () => {
    expectOnly(await new SessionsService(seedDb()).get(WS, actor('t-closed'), 'ses-closed'), [M.sesNotesClosed, M.sesSummaryClosed, M.titleClosed]);
  });

  it.each(label(TREATING))('%s ve las notas pero no el resumen interno ajeno', async (_l, key) => {
    expectOnly(await new SessionsService(seedDb()).get(WS, actor(key), 'ses-closed'), [M.sesNotesClosed, M.titleClosed]);
  });

  it.each(label(['owner-nc', 'admin-nc', 'admin-c-none', 'owner-flagoff', 'assistant'] as ActorKey[]))('%s → solo metadatos (agenda)', async (_l, key) => {
    const result: any = await new SessionsService(seedDb()).get(WS, actor(key), 'ses-closed');
    expect(result).toMatchObject({ id: 'ses-closed', therapistId: 't-closed' });
    expectOnly(result, []);
  });

  it.each(label(['t-other', 't-none'] as ActorKey[]))('%s → 403', async (_l, key) => {
    await expect(new SessionsService(seedDb()).get(WS, actor(key), 'ses-closed')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ------------------------------------------------------------------------------------------
// Mensajes con el paciente: solo su terapeuta, y solo los de su tratamiento.
// ------------------------------------------------------------------------------------------

describe('Mensajes con el paciente', () => {
  it.each(label(TREATING))('%s lee solo los mensajes desde el inicio de su proceso', async (_l, key) => {
    const result: any = await new MessagesService(seedDb()).thread(WS, actor(key), 'conv-1');
    expectOnly(result, [M.msgNew]);
    expect(result.readOnly).toBe(false);
  });

  it('el autor de un proceso cerrado lee solo los de su tratamiento, en solo lectura, sin marcarlos leídos', async () => {
    const prisma = seedDb();
    const result: any = await new MessagesService(prisma).thread(WS, actor('t-closed'), 'conv-1');
    expectOnly(result, [M.msgOld]);
    expect(result.readOnly).toBe(true);
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it.each(label(DENIED))('%s → 403 (ni cuerpo ni adjuntos)', async (_l, key) => {
    const prisma = seedDb();
    await expect(new MessagesService(prisma).thread(WS, actor(key), 'conv-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it.each(label(['owner-nc', 'admin-nc'] as ActorKey[]))('bandeja de %s: solo metadatos (sin vista previa ni no leídos)', async (_l, key) => {
    const rows: any[] = await new MessagesService(seedDb()).list(WS, actor(key));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'conv-1', status: 'OPEN', canReadMessages: false, messages: [], unreadCount: null });
    expect(rows[0]).not.toHaveProperty('_count');
    expectOnly(rows, []);
  });

  it('bandeja de quien trata: vista previa y no leídos solo de su ventana', async () => {
    const rows: any[] = await new MessagesService(seedDb()).list(WS, actor('t-active'));
    expect(rows[0]).toMatchObject({ canReadMessages: true, unreadCount: 1 });
    expectOnly(rows, [M.msgNew]);
  });

  it.each(label(NOT_TREATING.filter((k) => k !== 'assistant')))('%s no puede escribir al paciente → 403', async (_l, key) => {
    const prisma = seedDb();
    await expectDenied(prisma, () => new MessagesService(prisma).send(WS, actor(key), 'conv-1', { body: 'Texto ficticio' } as any));
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------
// Exportación clínica por paciente.
// ------------------------------------------------------------------------------------------

describe('POST /exports/patients/:id', () => {
  it.each(label(TREATING))('%s exporta el contenido clínico sin notas internas ni mensajes ajenos', async (_l, key) => {
    const result: any = await new ExportsService(seedDb()).exportPatient(actor(key), 'pat-1', PASSWORD);
    const out = json(result);
    for (const marker of [M.patientReason, M.history, M.goal, M.assessment, M.sesNotesClosed, M.reportClosed, M.reportActive, M.taskLoose]) expect(out).toContain(marker);
    expect(out).not.toContain(M.internalClosed);
    expect(out).not.toContain(M.sesSummaryClosed);
    expect(out).not.toMatch(/enc:v[12]:/);
  });

  it('el autor de un proceso cerrado exporta solo lo suyo', async () => {
    const result: any = await new ExportsService(seedDb()).exportPatient(actor('t-closed'), 'pat-1', PASSWORD);
    expectOnly(result, [M.titleClosed, M.procReasonClosed, M.internalClosed, M.sesNotesClosed, M.sesSummaryClosed, M.taskClosed, M.reportClosed, M.docClosed, M.consentNotes]);
  });

  it.each(label(DENIED.filter((k) => k !== 'assistant')))('%s → 403 auditado', async (_l, key) => {
    const prisma = seedDb();
    await expectDenied(prisma, () => new ExportsService(prisma).exportPatient(actor(key), 'pat-1', PASSWORD));
  });
});

// ------------------------------------------------------------------------------------------
// Escrituras clínicas: solo quien trata (el autor de un proceso cerrado ya no escribe).
// ------------------------------------------------------------------------------------------

describe('Escrituras clínicas', () => {
  it.each(label(TREATING))('%s actualiza la historia clínica', async (_l, key) => {
    const prisma = seedDb();
    await new PatientsService(prisma).updateClinicalHistory(WS, actor(key), 'pat-1', { currentProblem: 'Texto ficticio nuevo' } as any);
    expect(prisma.__store.auditLog).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'CLINICAL_HISTORY_UPDATED' })]));
  });

  it.each(label(NOT_TREATING))('%s → 403 sin escribir', async (_l, key) => {
    const prisma = seedDb();
    await expectDenied(prisma, () => new PatientsService(prisma).updateClinicalHistory(WS, actor(key), 'pat-1', { currentProblem: 'Texto ficticio nuevo' } as any));
    expect(prisma.clinicalHistory.updateMany).not.toHaveBeenCalled();
  });

  it('las notas internas del proceso solo las escribe su autor (OWNER que trata → 403)', async () => {
    const prisma = seedDb();
    await expectDenied(prisma, () => new ClinicalProcessesService(prisma).update(WS, actor('owner-c'), 'proc-active', { internalNotes: 'Texto ficticio' } as any));
    expect(prisma.clinicalProcess.updateMany).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------
// Consentimientos: dato administrativo (estado y fechas); las notas, solo quien trata.
// ------------------------------------------------------------------------------------------

describe('Consentimientos', () => {
  it.each(label(['owner-nc', 'admin-nc'] as ActorKey[]))('%s los gestiona sin ver sus notas', async (_l, key) => {
    const result: any[] = await new PatientsService(seedDb()).getConsentRecords(WS, actor(key), 'pat-1');
    expect(result[0]).toMatchObject({ id: 'con-1', status: 'SIGNED' });
    expect(result[0]).not.toHaveProperty('notes');
    expectOnly(result, []);
  });

  it('quien trata los ve completos', async () => {
    expectOnly(await new PatientsService(seedDb()).getConsentRecords(WS, actor('t-active'), 'pat-1'), [M.consentNotes]);
  });

  it.each(label(['t-none', 'assistant'] as ActorKey[]))('%s → 403', async (_l, key) => {
    await expect(new PatientsService(seedDb()).getConsentRecords(WS, actor(key), 'pat-1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ------------------------------------------------------------------------------------------
// Falla en cerrado: la decisión usa la BD, no el token.
// ------------------------------------------------------------------------------------------

describe('Falla en cerrado', () => {
  it('token con rol THERAPIST pero miembro ASSISTANT en la BD → 403', async () => {
    const prisma = seedDb();
    const member = prisma.__store.workspaceMember.find((m: any) => m.userId === 't-active');
    member.role = 'ASSISTANT';
    member.isClinician = false;
    await expectDenied(prisma, () => new PatientsService(prisma).getClinicalHistory(WS, actor('t-active'), 'pat-1'));
  });

  it('un THERAPIST cuenta siempre como clínico: el rol manda aunque el atributo diga otra cosa', async () => {
    const prisma = seedDb();
    prisma.__store.workspaceMember.find((m: any) => m.userId === 't-active').isClinician = false;
    expect(json(await new PatientsService(prisma).getClinicalHistory(WS, actor('t-active'), 'pat-1'))).toContain(M.history);
  });

  it('un ASSISTANT nunca es clínico aunque el atributo diga lo contrario', async () => {
    const prisma = seedDb();
    Object.assign(prisma.__store.workspaceMember.find((m: any) => m.userId === 'assistant'), { isClinician: true });
    prisma.__store.clinicalProcess.push({ ...prisma.__store.clinicalProcess[1], id: 'proc-asst', therapistId: 'assistant' });
    await expect(new PatientsService(prisma).getClinicalHistory(WS, actor('assistant'), 'pat-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('usuario que ya no es miembro del workspace → 403', async () => {
    const prisma = seedDb();
    prisma.__store.workspaceMember = prisma.__store.workspaceMember.filter((m: any) => m.userId !== 't-active');
    await expectDenied(prisma, () => new PatientsService(prisma).getClinicalHistory(WS, actor('t-active'), 'pat-1'));
  });

  it('paciente de otro workspace → 404, nunca contenido', async () => {
    const prisma = seedDb();
    await expect(new PatientsService(prisma).getClinicalHistory('ws-2', actor('t-active', { workspaceId: 'ws-2' }), 'pat-1')).rejects.toMatchObject({ status: 404 });
  });
});

// ------------------------------------------------------------------------------------------
// Condiciones de la revisión de seguridad.
// ------------------------------------------------------------------------------------------

describe('Reasignación de procesos (bloqueada hasta la reasignación controlada)', () => {
  it.each(label(['owner-nc', 'admin-nc', 'owner-c', 't-active'] as ActorKey[]))('%s: PATCH con therapistId → 400 sin escribir', async (_l, key) => {
    const prisma = seedDb();
    const error = await new ClinicalProcessesService(prisma).update(WS, actor(key), 'proc-active', { therapistId: 't-none' } as any).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('cierra el proceso y abre uno nuevo');
    expect(prisma.clinicalProcess.updateMany).not.toHaveBeenCalled();
    expect(prisma.__store.clinicalProcess.find((p: any) => p.id === 'proc-active').therapistId).toBe('t-active');
  });

  it('enviar el mismo therapistId no cuenta como reasignación', async () => {
    const prisma = seedDb();
    await new ClinicalProcessesService(prisma).update(WS, actor('owner-nc'), 'proc-active', { therapistId: 't-active', frequency: 'BIWEEKLY' } as any);
    expect(prisma.__store.clinicalProcess.find((p: any) => p.id === 'proc-active').frequency).toBe('BIWEEKLY');
  });
});

describe('Apertura de un proceso propio: auditoría de la autoasignación', () => {
  it('registra selfAssigned y si el paciente ya tenía otro profesional activo', async () => {
    const prisma = seedDb();
    await new ClinicalProcessesService(prisma).create(WS, actor('t-none'), { patientId: 'pat-1', title: 'Proceso ficticio' } as any);
    const audit = prisma.__store.auditLog.find((a: any) => a.action === 'CLINICAL_PROCESS_CREATED');
    expect(audit.metadata).toEqual(expect.objectContaining({ therapistId: 't-none', selfAssigned: true, hadOtherActiveClinician: true }));
  });

  it('sin otro profesional activo → hadOtherActiveClinician: false', async () => {
    const prisma = seedDb();
    prisma.__store.clinicalProcess = prisma.__store.clinicalProcess.filter((p: any) => p.patientId !== 'pat-2');
    await new ClinicalProcessesService(prisma).create(WS, actor('t-none'), { patientId: 'pat-2', title: 'Proceso ficticio' } as any);
    const audit = prisma.__store.auditLog.find((a: any) => a.action === 'CLINICAL_PROCESS_CREATED');
    expect(audit.metadata).toEqual(expect.objectContaining({ selfAssigned: true, hadOtherActiveClinician: false }));
  });
});

describe('Proceso en pausa: la ventana de mensajes termina en pausedAt, no en updatedAt', () => {
  it('un cambio administrativo posterior (updatedAt) no amplía la ventana', async () => {
    const prisma = seedDb();
    const proc = prisma.__store.clinicalProcess.find((p: any) => p.id === 'proc-closed');
    Object.assign(proc, { status: 'PAUSED', endedAt: null, pausedAt: d('2026-03-01T00:00:00Z'), updatedAt: d('2026-06-01T00:00:00Z') });
    expectOnly(await new MessagesService(prisma).thread(WS, actor('t-closed'), 'conv-1'), [M.msgOld]);
  });

  it('pasar a PAUSED fija pausedAt y reactivar lo limpia', async () => {
    const prisma = seedDb();
    const service = new ClinicalProcessesService(prisma);
    const row = () => prisma.__store.clinicalProcess.find((p: any) => p.id === 'proc-active');
    await service.changeStatus(WS, actor('t-active'), 'proc-active', 'PAUSED');
    expect(row().pausedAt).toBeInstanceOf(Date);
    await service.changeStatus(WS, actor('t-active'), 'proc-active', 'ACTIVE');
    expect(row().pausedAt).toBeNull();
  });
});
