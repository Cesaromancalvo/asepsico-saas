import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PatientAgendaService } from '../src/sessions/patient-agenda.service';
import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';
import { MessagesService } from '../src/messages/messages.service';
import { encryptField } from '../src/common/crypto/field-encryption';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Citas entre profesionales (decisión del Jefe del 02/10):
 *  1. Un clínico que TRATA al paciente ve fecha, hora, estado y profesional de las citas del
 *     paciente con otros profesionales, sin ningún contenido. Quien no lo trata, no.
 *  2. Cerrar o dar de alta un proceso con citas futuras → 409 PROCESS_HAS_FUTURE_SESSIONS, o
 *     cancelación explícita en la misma transacción, con auditoría.
 *  3. La bandeja de mensajes trae el profesional del proceso activo (solo metadatos).
 * Todo acotado al workspace. Datos 100 % ficticios.
 */

const WS = 'ws-1';
const WS2 = 'ws-2';
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number, hours = 10) => new Date(Date.now() + days * DAY + hours * 60 * 60 * 1000);
const enc = (text: string) => encryptField(text)!;

const M = {
  notesA: 'MARK-NOTES-A', summaryA: 'MARK-SUMMARY-A', notesB: 'MARK-NOTES-B', summaryB: 'MARK-SUMMARY-B',
  titleA: 'MARK-TITLE-A', titleB: 'MARK-TITLE-B', locationB: 'MARK-LOCATION-B', urlB: 'https://example.com/MARK-URL-B',
  otherTenant: 'MARK-OTHER-TENANT',
};
const ALL_MARKERS = Object.values(M);

type Role = 'THERAPIST' | 'OWNER' | 'ADMIN' | 'ASSISTANT';
const actor = (sub: string, role: Role, workspaceId = WS) => ({ sub, role, workspaceId, email: `${sub}@example.com` }) as any;

function seed() {
  const member = (userId: string, role: Role, isClinician: boolean, workspaceId = WS) => ({ id: `m-${userId}`, workspaceId, userId, role, isClinician });
  const proc = (id: string, therapistId: string, status: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, workspaceId: WS, patientId: 'pat-1', therapistId, status, title, consultationReason: null, goals: null, internalNotes: null,
    modality: 'ONLINE', frequency: 'WEEKLY', startedAt: new Date('2026-01-01'), endedAt: null, pausedAt: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...extra,
  });
  const ses = (id: string, therapistId: string, clinicalProcessId: string, startsAt: Date, extra: Record<string, unknown> = {}) => ({
    id, workspaceId: WS, patientId: 'pat-1', therapistId, clinicalProcessId, startsAt, endsAt: new Date(startsAt.getTime() + 50 * 60 * 1000),
    status: 'SCHEDULED', type: 'INDIVIDUAL', location: null, videoCallUrl: null, notes: null, internalSummary: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...extra,
  });
  return fakeClinicalDb({
    workspaceMember: [
      member('t-a', 'THERAPIST', true), member('t-b', 'THERAPIST', true), member('t-closed', 'THERAPIST', true),
      member('t-none', 'THERAPIST', true), member('owner', 'OWNER', false), member('admin', 'ADMIN', false),
      member('assistant', 'ASSISTANT', false), member('t-ws2', 'THERAPIST', true, WS2),
    ],
    patient: [
      { id: 'pat-1', workspaceId: WS, firstName: 'Paciente', lastName: 'Ficticio', status: 'ACTIVE', deletedAt: null },
      { id: 'pat-ws2', workspaceId: WS2, firstName: 'Ajeno', lastName: 'Ficticio', status: 'ACTIVE', deletedAt: null },
    ],
    clinicalProcess: [
      proc('proc-a', 't-a', 'ACTIVE', M.titleA, { updatedAt: new Date('2026-03-01') }),
      proc('proc-b', 't-b', 'ACTIVE', M.titleB, { updatedAt: new Date('2026-02-01') }),
      proc('proc-closed', 't-closed', 'CLOSED', 'Proceso cerrado', { endedAt: new Date('2026-01-15') }),
      { ...proc('proc-ws2', 't-ws2', 'ACTIVE', M.otherTenant), workspaceId: WS2, patientId: 'pat-ws2' },
    ],
    session: [
      ses('ses-a-past', 't-a', 'proc-a', at(-7), { status: 'COMPLETED', notes: enc(M.notesA) }),
      ses('ses-a-future', 't-a', 'proc-a', at(5), { notes: enc(M.notesA), internalSummary: enc(M.summaryA) }),
      ses('ses-a-cancelled', 't-a', 'proc-a', at(6), { status: 'CANCELLED' }),
      ses('ses-b-future', 't-b', 'proc-b', at(2), {
        type: 'COUPLE', location: M.locationB, videoCallUrl: M.urlB, notes: enc(M.notesB), internalSummary: enc(M.summaryB),
      }),
      // Fila de OTRO workspace que apunta (mal) al mismo paciente y proceso: nunca debe salir ni tocarse.
      { ...ses('ses-ws2', 't-ws2', 'proc-a', at(3), { notes: M.otherTenant }), workspaceId: WS2 },
    ],
    conversation: [
      { id: 'conv-1', workspaceId: WS, patientId: 'pat-1', status: 'OPEN', patientCanReply: true, closedAt: null, archivedAt: null, createdAt: new Date('2026-01-05'), updatedAt: new Date('2026-04-10') },
      { id: 'conv-ws2', workspaceId: WS2, patientId: 'pat-ws2', status: 'OPEN', patientCanReply: true, closedAt: null, archivedAt: null, createdAt: new Date('2026-01-05'), updatedAt: new Date('2026-04-10') },
    ],
  });
}

const json = (value: unknown) => JSON.stringify(value);
/** Sin narrativa clínica. `allowAgendaMetadata`: la vista administrativa sí trae lugar y enlace. */
const expectNoContent = (value: unknown, allowAgendaMetadata = false) => {
  const out = json(value);
  expect(out).not.toMatch(/enc:v[12]:/);
  const agendaMarkers: string[] = [M.locationB, M.urlB];
  for (const marker of ALL_MARKERS) {
    if (allowAgendaMetadata && agendaMarkers.includes(marker)) continue;
    expect(out).not.toContain(marker);
  }
  for (const key of ['notes', 'internalSummary', 'title', 'consultationReason', 'goals', 'internalNotes']) expect(out).not.toContain(`"${key}"`);
};
const deniedAudits = (prisma: any) => prisma.__store.auditLog.filter((row: any) => row.action === 'CLINICAL_ACCESS_DENIED');

describe('Agenda del paciente: citas con otros profesionales', () => {
  it('un THERAPIST que trata al paciente ve las citas de otro profesional solo como hueco (id, inicio, fin, estado, profesional)', async () => {
    const result: any = await new PatientAgendaService(seed()).agenda(WS, actor('t-a', 'THERAPIST'), 'pat-1');
    expect(result.view).toBe('TREATING');
    const busy = result.data.find((item: any) => item.id === 'ses-b-future');
    expect(busy.visibility).toBe('BUSY');
    expect(Object.keys(busy).sort()).toEqual(['endsAt', 'id', 'patientId', 'startsAt', 'status', 'therapist', 'visibility']);
    expect(Object.keys(busy.therapist).sort()).toEqual(['firstName', 'id', 'lastName']);
    expect(busy.therapist.id).toBe('t-b');
    // Nada que delate el tipo de cita, el lugar, el enlace ni el proceso.
    expect(json(busy)).not.toContain('COUPLE');
    expect(json(busy)).not.toContain('proc-b');
    expectNoContent(result);
  });

  it('sus propias citas salen con metadatos de agenda (sin notas ni título del proceso)', async () => {
    const result: any = await new PatientAgendaService(seed()).agenda(WS, actor('t-a', 'THERAPIST'), 'pat-1');
    const own = result.data.find((item: any) => item.id === 'ses-a-future');
    expect(own.visibility).toBe('FULL');
    expect(own.clinicalProcess).toEqual({ id: 'proc-a', modality: 'ONLINE', status: 'ACTIVE' });
    expectNoContent(result);
  });

  it('la próxima sesión tiene en cuenta las citas con otros profesionales', async () => {
    const result: any = await new PatientAgendaService(seed()).agenda(WS, actor('t-a', 'THERAPIST'), 'pat-1');
    expect(result.nextSession.id).toBe('ses-b-future');
    expect(result.nextSession.visibility).toBe('BUSY');
  });

  it('nunca devuelve citas de otro workspace', async () => {
    const result: any = await new PatientAgendaService(seed()).agenda(WS, actor('t-a', 'THERAPIST'), 'pat-1');
    expect(result.data.map((item: any) => item.id)).not.toContain('ses-ws2');
    const admin: any = await new PatientAgendaService(seed()).agenda(WS, actor('assistant', 'ASSISTANT'), 'pat-1');
    expect(admin.data.map((item: any) => item.id)).not.toContain('ses-ws2');
  });

  it.each([
    ['t-closed', 'autor de un proceso CERRADO'],
    ['t-none', 'sin proceso con el paciente'],
  ])('un THERAPIST que no trata al paciente (%s, %s) → 403 auditado, sin datos', async (sub) => {
    const prisma = seed();
    await expect(new PatientAgendaService(prisma).agenda(WS, actor(sub, 'THERAPIST'), 'pat-1')).rejects.toBeInstanceOf(ForbiddenException);
    const audits = deniedAudits(prisma);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata.resource).toBe('patient-agenda');
  });

  it('un paciente de otro workspace → 404 (también para un THERAPIST que lo trata allí)', async () => {
    await expect(new PatientAgendaService(seed()).agenda(WS, actor('t-a', 'THERAPIST'), 'pat-ws2')).rejects.toBeInstanceOf(NotFoundException);
    await expect(new PatientAgendaService(seed()).agenda(WS, actor('owner', 'OWNER'), 'pat-ws2')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([['owner', 'OWNER'], ['admin', 'ADMIN'], ['assistant', 'ASSISTANT']] as const)(
    '%s mantiene la vista administrativa (todas las citas, sin contenido)', async (sub, role) => {
      const result: any = await new PatientAgendaService(seed()).agenda(WS, actor(sub, role), 'pat-1');
      expect(result.view).toBe('ADMINISTRATIVE');
      expect(result.data.map((item: any) => item.id).sort()).toEqual(['ses-a-cancelled', 'ses-a-future', 'ses-a-past', 'ses-b-future']);
      expect(result.data.every((item: any) => item.visibility === 'FULL')).toBe(true);
      // Lo mismo que ya ven en GET /sessions (lugar y enlace incluidos), nunca notas ni título.
      expectNoContent(result, true);
    });

  it('un rol desconocido → 403', async () => {
    await expect(new PatientAgendaService(seed()).agenda(WS, actor('x', 'PATIENT' as Role), 'pat-1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Cerrar o dar de alta un proceso con citas futuras', () => {
  it.each(['CLOSED', 'DISCHARGED'] as const)('%s sin confirmar → 409 PROCESS_HAS_FUTURE_SESSIONS con las citas (metadatos) y nada cambia', async (status) => {
    const prisma = seed();
    const error = await new ClinicalProcessesService(prisma).changeStatus(WS, actor('t-a', 'THERAPIST'), 'proc-a', status).catch((err) => err);
    expect(error).toBeInstanceOf(ConflictException);
    const body: any = error.getResponse();
    expect(body.code).toBe('PROCESS_HAS_FUTURE_SESSIONS');
    expect(body.statusCode).toBe(409);
    // Solo la futura programada de ESTE proceso y workspace (ni la pasada, ni la cancelada, ni la de otro).
    expect(body.sessions.map((session: any) => session.id)).toEqual(['ses-a-future']);
    expect(Object.keys(body.sessions[0]).sort()).toEqual(['endsAt', 'id', 'patientId', 'startsAt', 'status', 'therapist']);
    expectNoContent(body);
    const store = prisma.__store;
    expect(store.clinicalProcess.find((row: any) => row.id === 'proc-a').status).toBe('ACTIVE');
    expect(store.session.find((row: any) => row.id === 'ses-a-future').status).toBe('SCHEDULED');
    expect(store.auditLog.filter((row: any) => row.action === 'CLINICAL_PROCESS_STATUS_CHANGED')).toHaveLength(0);
  });

  it('con cancelFutureSessions cancela solo las futuras del proceso, en la misma transacción y con auditoría', async () => {
    const prisma = seed();
    let inTransaction = false;
    const writes: Array<{ op: string; inTransaction: boolean }> = [];
    const track = (model: string, op: string) => {
      const original = prisma[model][op];
      prisma[model][op] = jest.fn(async (args: any) => { writes.push({ op: `${model}.${op}`, inTransaction }); return original(args); });
    };
    track('session', 'updateMany'); track('clinicalProcess', 'updateMany'); track('auditLog', 'create'); track('auditLog', 'createMany');
    prisma.$transaction = jest.fn(async (cb: any) => { inTransaction = true; try { return await cb(prisma); } finally { inTransaction = false; } });

    const result: any = await new ClinicalProcessesService(prisma).changeStatus(WS, actor('t-a', 'THERAPIST'), 'proc-a', 'CLOSED', { cancelFutureSessions: true });
    expect(result.status).toBe('CLOSED');

    const store = prisma.__store;
    const status = (id: string) => store.session.find((row: any) => row.id === id).status;
    expect(status('ses-a-future')).toBe('CANCELLED');
    expect(status('ses-a-past')).toBe('COMPLETED');
    expect(status('ses-b-future')).toBe('SCHEDULED');
    expect(status('ses-ws2')).toBe('SCHEDULED');

    expect(writes.length).toBeGreaterThanOrEqual(4);
    expect(writes.every((write) => write.inTransaction)).toBe(true);
    // Todas las escrituras de sesiones y procesos van acotadas al workspace.
    for (const call of [...prisma.session.updateMany.mock.calls, ...prisma.clinicalProcess.updateMany.mock.calls]) {
      expect(call[0].where.workspaceId).toBe(WS);
    }

    const sessionAudit = store.auditLog.filter((row: any) => row.action === 'SESSION_STATUS_CHANGED');
    expect(sessionAudit).toHaveLength(1);
    expect(sessionAudit[0]).toMatchObject({ workspaceId: WS, actorId: 't-a', entityId: 'ses-a-future', metadata: { from: 'SCHEDULED', to: 'CANCELLED', reason: 'CLINICAL_PROCESS_CLOSED', clinicalProcessId: 'proc-a' } });
    const processAudit = store.auditLog.filter((row: any) => row.action === 'CLINICAL_PROCESS_STATUS_CHANGED');
    expect(processAudit).toHaveLength(1);
    expect(processAudit[0].metadata).toEqual({ from: 'ACTIVE', to: 'CLOSED', cancelledFutureSessions: 1 });
    expectNoContent(store.auditLog);
  });

  it('si la auditoría falla dentro de la transacción, el error se propaga (Prisma revierte; no se devuelve éxito)', async () => {
    const prisma = seed();
    prisma.auditLog.createMany = jest.fn(async () => { throw new Error('fallo de auditoría simulado'); });
    await expect(new ClinicalProcessesService(prisma).changeStatus(WS, actor('t-a', 'THERAPIST'), 'proc-a', 'CLOSED', { cancelFutureSessions: true }))
      .rejects.toThrow('fallo de auditoría simulado');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('sin citas futuras cierra sin pedir nada; pausar no se bloquea por citas futuras', async () => {
    const prisma = seed();
    const service = new ClinicalProcessesService(prisma);
    const paused: any = await service.changeStatus(WS, actor('t-b', 'THERAPIST'), 'proc-b', 'PAUSED');
    expect(paused.status).toBe('PAUSED');
    prisma.__store.session.find((row: any) => row.id === 'ses-b-future').status = 'CANCELLED';
    const closed: any = await service.changeStatus(WS, actor('t-b', 'THERAPIST'), 'proc-b', 'CLOSED');
    expect(closed.status).toBe('CLOSED');
  });

  it('otro THERAPIST no puede cerrar el proceso ajeno ni ver sus citas en el 409', async () => {
    const error = await new ClinicalProcessesService(seed()).changeStatus(WS, actor('t-b', 'THERAPIST'), 'proc-a', 'CLOSED').catch((err) => err);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(json(error.getResponse())).not.toContain('ses-a-future');
  });

  it('ASSISTANT no puede cerrar procesos', async () => {
    await expect(new ClinicalProcessesService(seed()).changeStatus(WS, actor('assistant', 'ASSISTANT'), 'proc-a', 'CLOSED', { cancelFutureSessions: true }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un proceso de otro workspace → 404 aunque se pida cancelar', async () => {
    const prisma = seed();
    await expect(new ClinicalProcessesService(prisma).changeStatus(WS, actor('owner', 'OWNER'), 'proc-ws2', 'CLOSED', { cancelFutureSessions: true }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.__store.session.find((row: any) => row.id === 'ses-ws2').status).toBe('SCHEDULED');
  });

  it('OWNER (gestión administrativa) también recibe el 409 y puede cancelar explícitamente', async () => {
    const prisma = seed();
    const service = new ClinicalProcessesService(prisma);
    await expect(service.changeStatus(WS, actor('owner', 'OWNER'), 'proc-a', 'DISCHARGED')).rejects.toBeInstanceOf(ConflictException);
    const result: any = await service.changeStatus(WS, actor('owner', 'OWNER'), 'proc-a', 'DISCHARGED', { cancelFutureSessions: true });
    expect(result.status).toBe('DISCHARGED');
    expectNoContent(result);
  });
});

describe('GET /messages: profesional del proceso activo', () => {
  const row = async (sub: string, role: Role) => {
    const rows: any[] = await new MessagesService(seed()).list(WS, actor(sub, role));
    return rows.find((item) => item.id === 'conv-1');
  };

  it('OWNER/ADMIN ven el profesional del proceso activo más reciente, solo id y nombre', async () => {
    for (const [sub, role] of [['owner', 'OWNER'], ['admin', 'ADMIN']] as const) {
      const conversation = await row(sub, role);
      expect(Object.keys(conversation.therapist).sort()).toEqual(['firstName', 'id', 'lastName']);
      expect(conversation.therapist.id).toBe('t-a');
    }
  });

  it('un THERAPIST que trata al paciente ve preferentemente su propio proceso activo', async () => {
    expect((await row('t-b', 'THERAPIST')).therapist.id).toBe('t-b');
    expect((await row('t-a', 'THERAPIST')).therapist.id).toBe('t-a');
  });

  it('el autor de un proceso cerrado no averigua quién trata ahora al paciente', async () => {
    const conversation = await row('t-closed', 'THERAPIST');
    if (conversation) expect(conversation.therapist).toBeNull();
  });

  it('no mezcla workspaces', async () => {
    const rows: any[] = await new MessagesService(seed()).list(WS, actor('owner', 'OWNER'));
    expect(rows.map((item) => item.id)).not.toContain('conv-ws2');
    expect(json(rows)).not.toContain('t-ws2');
  });
});
