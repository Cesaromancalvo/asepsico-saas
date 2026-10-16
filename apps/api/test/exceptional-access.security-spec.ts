import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { hashSync } from 'bcryptjs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ExceptionalAccessService } from '../src/exceptional-access/exceptional-access.service';
import { ExceptionalAccessRegisterService, sendDeferredNoticeReminders } from '../src/exceptional-access/exceptional-access-register.service';
import { ExceptionalAccessController } from '../src/exceptional-access/exceptional-access.controller';
import { CreateExceptionalAccessDto } from '../src/exceptional-access/dto/exceptional-access.dto';
import { PatientsService } from '../src/patients/patients.service';
import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { ExportsService } from '../src/exports/exports.service';
import { AuthService } from '../src/auth/auth.service';
import { encryptField } from '../src/common/crypto/field-encryption';
import { migrateLegacyExceptionalReasons } from '../src/exceptional-access/legacy-reason-migration';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Acceso excepcional H1–H4 (docs/producto/acceso-excepcional.md): CA1.x, CA2.x, CA3.x, CA4.x y
 * las decisiones del Jefe del 15/10 sobre §9.1. Datos 100 % ficticios.
 */

const WS = 'ws-1';
const PASSWORD = 'contrasena-ficticia-de-test';
const PASSWORD_HASH = hashSync(PASSWORD, 4);
const HOUR = 3_600_000;
const d = (iso: string) => new Date(iso);
const enc = (text: string) => encryptField(text)!;

const M = {
  history: 'MARK-HISTORY', internal: 'MARK-INTERNAL-NOTES', summary: 'MARK-SES-INTERNAL', sesNotes: 'MARK-SES-NOTES',
  clinicianNotes: 'MARK-CLINICIAN-NOTES', procReason: 'MARK-PROC-REASON', consentNotes: 'MARK-CONSENT-NOTES',
};
const JUSTIFICATION = 'Requerimiento ficticio del Juzgado n.º 0, procedimiento 000/2026.';
const DEFER = 'Diferido por instrucción ficticia de la autoridad hasta nueva orden.';

const ROLES: Record<string, { role: string; isClinician: boolean }> = {
  'owner-c': { role: 'OWNER', isClinician: true },
  'owner-nc': { role: 'OWNER', isClinician: false },
  'admin-nc': { role: 'ADMIN', isClinician: false },
  'admin-c': { role: 'ADMIN', isClinician: true },
  't-a': { role: 'THERAPIST', isClinician: true },
  't-b': { role: 'THERAPIST', isClinician: true },
  assistant: { role: 'ASSISTANT', isClinician: false },
};
const actor = (key: string, sid: string | undefined = `sid-${key}`) => ({ sub: key, workspaceId: WS, role: ROLES[key].role, email: `${key}@example.com`, ...(sid ? { sid } : {}) }) as any;

function seed() {
  const future = new Date(Date.now() + 7 * 24 * HOUR);
  return fakeClinicalDb({
    user: Object.keys(ROLES).map((id) => ({ id, firstName: 'Nombre', lastName: id, passwordHash: PASSWORD_HASH })),
    workspaceMember: Object.entries(ROLES).map(([userId, m], i) => ({ id: `m${i}`, workspaceId: WS, userId, ...m, user: { firstName: 'Nombre', lastName: userId } })),
    refreshToken: ['owner-c', 'owner-nc', 'admin-nc', 'admin-c'].flatMap((key) => [
      { id: `rt-${key}`, userId: key, workspaceId: WS, family: `sid-${key}`, tokenHash: `h-${key}`, expiresAt: future, revokedAt: null },
      { id: `rt-${key}-2`, userId: key, workspaceId: WS, family: `sid-${key}-otro`, tokenHash: `h2-${key}`, expiresAt: future, revokedAt: null },
    ]),
    patient: [
      { id: 'pat-1', workspaceId: WS, firstName: 'Ana', lastName: 'Ficticia', status: 'ACTIVE', deletedAt: null, blockedAt: null, consultationReason: null, createdAt: d('2026-01-01'), updatedAt: d('2026-01-01') },
      { id: 'pat-x', workspaceId: 'ws-2', firstName: 'Otro', lastName: 'Workspace', status: 'ACTIVE', deletedAt: null, blockedAt: null, createdAt: d('2026-01-01') },
      { id: 'pat-del', workspaceId: WS, firstName: 'Borrado', lastName: 'Ficticio', status: 'ARCHIVED', deletedAt: d('2026-05-01'), blockedAt: null, createdAt: d('2026-01-01') },
    ],
    clinicalProcess: [
      { id: 'proc-a', workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', status: 'ACTIVE', title: 'Proceso ficticio', consultationReason: enc(M.procReason), goals: null, internalNotes: enc(M.internal), modality: 'IN_PERSON', startedAt: d('2026-02-01'), endedAt: null, createdAt: d('2026-02-01'), updatedAt: d('2026-02-01') },
      { id: 'proc-gone', workspaceId: WS, patientId: 'pat-1', therapistId: 't-gone', status: 'CLOSED', title: 'Proceso ficticio', internalNotes: null, createdAt: d('2025-01-01'), updatedAt: d('2025-02-01'), endedAt: d('2025-02-01') },
      { id: 'proc-admin', workspaceId: WS, patientId: 'pat-1', therapistId: 'admin-c', status: 'ACTIVE', title: 'Proceso ficticio', internalNotes: null, createdAt: d('2026-03-01'), updatedAt: d('2026-03-01') },
    ],
    session: [
      { id: 'ses-a', workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', clinicalProcessId: 'proc-a', startsAt: d('2026-02-10'), endsAt: d('2026-02-10'), status: 'COMPLETED', type: 'INDIVIDUAL', notes: enc(M.sesNotes), internalSummary: enc(M.summary), createdAt: d('2026-02-10'), updatedAt: d('2026-02-10') },
    ],
    clinicalHistory: [{ id: 'hist-1', patientId: 'pat-1', currentProblem: enc(M.history), createdAt: d('2026-02-01'), updatedAt: d('2026-02-01') }],
    therapeuticTask: [{ id: 'task-1', patientId: 'pat-1', sessionId: 'ses-a', therapyGoalId: null, title: enc('Tarea ficticia'), instructions: null, clinicianNotes: enc(M.clinicianNotes), status: 'PENDING', createdAt: d('2026-02-10'), updatedAt: d('2026-02-10') }],
    clinicalAssessment: [],
    consentRecord: [{ id: 'con-1', workspaceId: WS, patientId: 'pat-1', createdById: 't-a', type: 'INFORMED_CONSENT', title: 'Consentimiento', status: 'SIGNED', notes: enc(M.consentNotes), createdAt: d('2026-02-01'), updatedAt: d('2026-02-01') }],
    patientPortalAccount: [],
  } as any);
}

const store = (p: any) => p.__store;
const json = (v: unknown) => JSON.stringify(v);
const body = (code = 'LEGAL_REQUIREMENT', extra: Record<string, unknown> = {}) => ({ reasonCode: code, justification: JUSTIFICATION, confirmed: true, ...extra }) as any;
const svc = (p: any) => new ExceptionalAccessService(p);
const reg = (p: any) => new ExceptionalAccessRegisterService(p);
const patients = (p: any) => new PatientsService(p);

async function rejects(run: () => Promise<unknown>, type: any, code?: string) {
  let caught: any;
  try { await run(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(type);
  if (code) expect(caught.getResponse().code).toBe(code);
  return caught;
}
const records = (p: any) => store(p).exceptionalAccessJustification;

// ------------------------------------------------------------------------------------------
describe('H1 · registrar un acceso excepcional', () => {
  it('CA1.1 sin acceso vigente, E1 sigue denegando al OWNER (sin regresión)', async () => {
    const p = seed();
    await rejects(() => patients(p).getClinicalHistory(WS, actor('owner-c'), 'pat-1'), ForbiddenException);
  });

  it('CA1.2 OWNER/ADMIN que ya trata al paciente → 409 y no se crea registro', async () => {
    const p = seed();
    await rejects(() => svc(p).create(WS, actor('admin-c'), 'pat-1', body()), ConflictException, 'EXCEPTIONAL_ACCESS_NOT_NEEDED');
    expect(records(p)).toHaveLength(0);
  });

  it.each(['t-a', 't-b', 'assistant'])('CA1.3 %s → 403 y no se crea registro', async (key) => {
    const p = seed();
    await rejects(() => svc(p).create(WS, actor(key), 'pat-1', body()), ForbiddenException);
    expect(records(p)).toHaveLength(0);
  });

  it('CA1.4 explicación corta o casilla sin marcar → 400 (servicio y DTO)', async () => {
    const p = seed();
    await rejects(() => svc(p).create(WS, actor('owner-c'), 'pat-1', body('LEGAL_REQUIREMENT', { justification: 'demasiado corta' })), BadRequestException);
    await rejects(() => svc(p).create(WS, actor('owner-c'), 'pat-1', body('LEGAL_REQUIREMENT', { confirmed: false })), BadRequestException);
    expect(records(p)).toHaveLength(0);
    const errors = async (o: object) => (await validate(plainToInstance(CreateExceptionalAccessDto, o))).map((e) => e.property);
    expect(await errors({ justification: JUSTIFICATION, confirmed: true })).toContain('reasonCode');
    expect(await errors(body('LEGAL_REQUIREMENT', { justification: 'x'.repeat(19) }))).toContain('justification');
    expect(await errors(body('LEGAL_REQUIREMENT', { justification: 'x'.repeat(301) }))).toContain('justification');
    expect(await errors(body('LEGAL_REQUIREMENT', { confirmed: false }))).toContain('confirmed');
  });

  it('CA1.5 código fuera del catálogo (OTHER) → 400', async () => {
    const p = seed();
    await rejects(() => svc(p).create(WS, actor('owner-c'), 'pat-1', body('OTHER')), BadRequestException);
    expect((await validate(plainToInstance(CreateExceptionalAccessDto, body('OTHER')))).map((e) => e.property)).toContain('reasonCode');
    expect(records(p)).toHaveLength(0);
  });

  it.each(['owner-nc', 'admin-nc'])('CA1.6 + §9.1 a: %s (sin perfil clínico) → 403 con códigos clínicos; acepta los administrativos', async (key) => {
    const p = seed();
    for (const code of ['CONTINUITY_OF_CARE', 'VITAL_URGENCY']) {
      await rejects(() => svc(p).create(WS, actor(key), 'pat-1', body(code)), ForbiddenException);
    }
    expect(records(p)).toHaveLength(0);
    await svc(p).create(WS, actor(key), 'pat-1', body('PATIENT_RIGHTS_REQUEST'));
    expect(records(p)).toHaveLength(1);
    const current: any = await svc(p).current(WS, actor(key, 'sid-otra'), 'pat-1');
    expect(current.allowedReasons).toEqual(['PATIENT_RIGHTS_REQUEST', 'LEGAL_REQUIREMENT', 'CLAIM_DEFENCE', 'CUSTODY', 'DATA_INCIDENT']);
  });

  it('CA1.7 términos clínicos: avisa (400 reconocible); si continúa, se guarda marcado', async () => {
    const p = seed();
    const clinical = body('DATA_INCIDENT', { justification: 'Corregir el diagnóstico ficticio mal asignado a otra ficha.' });
    await rejects(() => svc(p).create(WS, actor('owner-c'), 'pat-1', clinical), BadRequestException, 'CLINICAL_TERMS_WARNING');
    expect(records(p)).toHaveLength(0);
    await svc(p).create(WS, actor('owner-c'), 'pat-1', { ...clinical, clinicalTermWarningAcknowledged: true });
    expect(records(p)[0].clinicalTermWarningIgnored).toBe(true);
  });

  it('CA1.8 una transacción: registro cifrado, 8 h, 5 años, sesión y número de OWNER; auditoría solo con códigos', async () => {
    const p = seed();
    const res: any = await svc(p).create(WS, actor('owner-c'), 'pat-1', body());
    const [row] = records(p);
    expect(p.$transaction).toHaveBeenCalled();
    expect(row.justification).toMatch(/^enc:v/);
    expect(row.justification).not.toContain('Juzgado');
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(8 * HOUR);
    expect(row.retentionUntil.getUTCFullYear() - row.createdAt.getUTCFullYear()).toBe(5);
    expect(row).toMatchObject({ authSessionId: 'sid-owner-c', ownerCountAtCreation: 2, workspaceId: WS, actorRole: 'OWNER' });
    const audit = store(p).auditLog.find((a: any) => a.action === 'EXCEPTIONAL_CLINICAL_ACCESS');
    expect(audit.metadata).toEqual({ reasonCode: 'LEGAL_REQUIREMENT', role: 'OWNER', exceptionalAccessId: res.id });
    expect(json(res)).not.toMatch(/Juzgado|enc:v|justification/);
    const current: any = await svc(p).current(WS, actor('owner-c'), 'pat-1');
    expect(current.active).toEqual(expect.objectContaining({ id: res.id, reasonCode: 'LEGAL_REQUIREMENT' }));
    expect(json(current)).not.toMatch(/enc:v|justification|authSessionId/);
  });

  it('CA1.9 el texto nunca sale en AuditLog, avisos, registro ni exportación ordinaria del workspace', async () => {
    const p = seed();
    await svc(p).create(WS, actor('owner-c'), 'pat-1', body());
    await reg(p).list(WS, actor('owner-c'));
    const exported: any = await new ExportsService(p).exportWorkspace(actor('owner-c'), PASSWORD).catch(() => null);
    for (const value of [store(p).auditLog, store(p).notification, await reg(p).list(WS, actor('owner-c')), exported]) {
      expect(json(value)).not.toContain('Juzgado');
    }
  });

  it('CA1.10 paciente de otro workspace o borrado → 404', async () => {
    const p = seed();
    await rejects(() => svc(p).create(WS, actor('owner-c'), 'pat-x', body()), NotFoundException);
    await rejects(() => svc(p).create(WS, actor('owner-c'), 'pat-del', body()), NotFoundException);
    expect(records(p)).toHaveLength(0);
  });

  it('CA1.11 "Mi motivo no está en la lista": solo un contador por workspace, sin paciente, usuario ni texto', async () => {
    const p = seed();
    p.exceptionalAccessReasonMiss.upsert = jest.fn(async () => ({}));
    await svc(p).countReasonMiss(WS, actor('owner-nc'));
    expect(p.exceptionalAccessReasonMiss.upsert).toHaveBeenCalledWith({ where: { workspaceId: WS }, create: { workspaceId: WS, count: 1 }, update: { count: { increment: 1 } } });
    expect(records(p)).toHaveLength(0);
    await rejects(() => svc(p).countReasonMiss(WS, actor('t-a')), ForbiddenException);
  });

  it('sin `sid` en el token (sesión anterior) → 401 SESSION_REQUIRED y no se crea nada', async () => {
    const p = seed();
    const caught = await rejects(() => svc(p).create(WS, actor('owner-c', ''), 'pat-1', body()), Error);
    expect(caught.getStatus()).toBe(401);
    expect(records(p)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------
describe('H2 · leer durante la ventana y cerrarla', () => {
  async function granted(code = 'LEGAL_REQUIREMENT', who = 'owner-c') {
    const p = seed();
    const res: any = await svc(p).create(WS, actor(who), 'pat-1', body(code));
    return { p, id: res.id as string };
  }

  it('CA2.1 con acceso vigente lee y cada lectura se audita con el exceptionalAccessId', async () => {
    const { p, id } = await granted();
    expect(json(await patients(p).getClinicalHistory(WS, actor('owner-c'), 'pat-1'))).toContain(M.history);
    const reads = store(p).auditLog.filter((a: any) => a.action === 'EXCEPTIONAL_ACCESS_READ');
    expect(reads).toEqual([expect.objectContaining({ entityId: 'pat-1', metadata: { resource: 'clinical-history', exceptionalAccessId: id, reasonCode: 'LEGAL_REQUIREMENT' } })]);
  });

  it('CA2.2 ninguna nota interna: proceso, sesión, tareas', async () => {
    const { p } = await granted();
    const owner = actor('owner-c');
    const process: any = await new ClinicalProcessesService(p).get(WS, owner, 'proc-a');
    expect(json(process)).toContain(M.procReason);
    expect(process).not.toHaveProperty('internalNotes');
    expect(json(process)).not.toContain(M.internal);
    expect(json(process)).not.toContain(M.summary);
    expect(process.readOnly).toBe(true);
    const session: any = await new SessionsService(p).get(WS, owner, 'ses-a');
    expect(json(session)).toContain(M.sesNotes);
    expect(json(session)).not.toContain(M.summary);
    const tasks: any = await patients(p).getTherapeuticTasks(WS, owner, 'pat-1');
    expect(json(tasks)).not.toContain(M.clinicianNotes);
    const consents: any = await patients(p).getConsentRecords(WS, owner, 'pat-1');
    expect(json(consents)).toContain('con-1');
    expect(json(consents)).not.toContain(M.consentNotes);
  });

  it('CA2.3 ninguna escritura con acceso excepcional', async () => {
    const { p } = await granted();
    const owner = actor('owner-c');
    await rejects(() => patients(p).updateClinicalHistory(WS, owner, 'pat-1', { currentProblem: 'Texto ficticio' } as any), ForbiddenException);
    await rejects(() => patients(p).createTherapyGoal(WS, owner, 'pat-1', { title: 'Objetivo ficticio' } as any), ForbiddenException);
    await rejects(() => new ClinicalProcessesService(p).update(WS, owner, 'proc-a', { goals: 'Texto ficticio' } as any), ForbiddenException);
  });

  const read = (p: any, who = actor('owner-c')) => patients(p).getClinicalHistory(WS, who, 'pat-1');

  it('CA2.4 vencido → 403', async () => {
    const { p } = await granted();
    records(p)[0].expiresAt = new Date(Date.now() - 1000);
    await rejects(() => read(p), ForbiddenException);
  });

  it('CA2.4 [Cerrar acceso] → 403', async () => {
    const { p, id } = await granted();
    await svc(p).close(WS, actor('owner-c'), 'pat-1', id);
    await rejects(() => read(p), ForbiddenException);
    await rejects(() => svc(p).close(WS, actor('owner-c'), 'pat-1', id), NotFoundException);
  });

  it('CA2.4 tras logout, el mismo access token (aún no caducado) → 403', async () => {
    const { p } = await granted();
    await new AuthService(p, {} as any, {} as any).logout(undefined, actor('owner-c'));
    await rejects(() => read(p), ForbiddenException);
    expect(records(p)[0]).toMatchObject({ closeReason: 'LOGOUT' });
  });

  it('CA2.4 sesión revocada o caducada en el servidor (sin pasar por logout) → 403', async () => {
    const { p } = await granted();
    store(p).refreshToken.find((t: any) => t.family === 'sid-owner-c').revokedAt = new Date();
    await rejects(() => read(p), ForbiddenException);
  });

  it('CA2.4 otra sesión del mismo usuario no hereda el acceso → 403', async () => {
    const { p } = await granted();
    await rejects(() => read(p, actor('owner-c', 'sid-owner-c-otro')), ForbiddenException);
  });

  it('CA2.4 paciente borrado → 403', async () => {
    const { p } = await granted();
    store(p).patient.find((x: any) => x.id === 'pat-1').deletedAt = new Date();
    await rejects(() => new ClinicalProcessesService(p).get(WS, actor('owner-c'), 'proc-a'), ForbiddenException);
  });

  it('CA2.4 el actor pierde el rol OWNER/ADMIN (en la BD) → 403 aunque el token diga OWNER', async () => {
    const { p } = await granted();
    store(p).workspaceMember.find((m: any) => m.userId === 'owner-c').role = 'THERAPIST';
    await rejects(() => read(p), ForbiddenException);
  });

  it('CA2.5 otro OWNER/ADMIN no usa el acceso de A → 403', async () => {
    const { p } = await granted();
    await rejects(() => read(p, actor('admin-nc')), ForbiddenException);
    await rejects(() => read(p, actor('owner-nc')), ForbiddenException);
  });

  it('CA2.6 no hay renovación: no existe la ruta y un segundo registro con uno vigente → 409; tras cerrarlo, registro nuevo', async () => {
    const routes = Object.getOwnPropertyNames(ExceptionalAccessController.prototype).join(',');
    expect(routes).not.toMatch(/renew|extend/i);
    const { p, id } = await granted();
    await rejects(() => svc(p).create(WS, actor('owner-c'), 'pat-1', body()), ConflictException);
    await svc(p).close(WS, actor('owner-c'), 'pat-1', id);
    await svc(p).create(WS, actor('owner-c'), 'pat-1', body());
    expect(records(p)).toHaveLength(2);
  });

  it.each(['CONTINUITY_OF_CARE', 'VITAL_URGENCY', 'CUSTODY', 'DATA_INCIDENT'])('CA2.7 exportación completa con %s → 403 auditado, nada generado', async (code) => {
    const { p, id } = await granted(code);
    await rejects(() => new ExportsService(p).exportPatient(actor('owner-c'), 'pat-1', PASSWORD), ForbiddenException);
    expect(store(p).auditLog.map((a: any) => a.action)).not.toContain('PATIENT_DATA_EXPORTED');
    expect(store(p).auditLog).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'EXCEPTIONAL_ACCESS_EXPORT_DENIED', metadata: { exceptionalAccessId: id, reasonCode: code } })]));
  });

  it.each(['PATIENT_RIGHTS_REQUEST', 'LEGAL_REQUIREMENT', 'CLAIM_DEFENCE'])('CA2.7 exportación con %s: sin notas internas y auditada con el exceptionalAccessId', async (code) => {
    const { p, id } = await granted(code);
    const out: any = await new ExportsService(p).exportPatient(actor('owner-c'), 'pat-1', PASSWORD);
    const text = json(out);
    expect(text).toContain(M.history);
    // Condición de Argos: tampoco las notas de los consentimientos (en pantalla están ocultas).
    expect(text).toContain('con-1');
    for (const hidden of [M.internal, M.summary, M.clinicianNotes, M.consentNotes]) expect(text).not.toContain(hidden);
    expect(store(p).auditLog).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'PATIENT_DATA_EXPORTED', metadata: expect.objectContaining({ exceptionalAccessId: id, reasonCode: code, scope: 'EXCEPTIONAL' }) })]));
  });
});

// ------------------------------------------------------------------------------------------
describe('H3 · aviso al terapeuta titular', () => {
  it('CA3.1 + CA3.3 aviso en la app al titular miembro, sin explicación; no al que ya no es miembro', async () => {
    const p = seed();
    await svc(p).create(WS, actor('owner-c'), 'pat-1', body('CUSTODY'));
    const notices = store(p).notification;
    expect(notices.map((n: any) => n.userId).sort()).toEqual(['admin-c', 't-a']);
    expect(notices.every((n: any) => n.type === 'CLINICAL_ACCESS_NOTICE' && n.audience === 'PROFESSIONAL')).toBe(true);
    expect(json(notices)).not.toContain('Juzgado');
    expect(notices[0].body).toContain('A. F.');
    expect(notices[0].body).toContain('Custodia de la historia');
  });

  it('CA3.2 el titular ve "Accesos de otras personas" sin texto; quien no es autor → 403', async () => {
    const p = seed();
    await svc(p).create(WS, actor('owner-c'), 'pat-1', body());
    const history: any = await reg(p).patientAccessHistory(WS, actor('t-a'), 'pat-1');
    expect(history.accesses).toEqual([expect.objectContaining({ actorId: 'owner-c', actorRole: 'OWNER', reasonCode: 'LEGAL_REQUIREMENT' })]);
    expect(json(history)).not.toContain('Juzgado');
    await rejects(() => reg(p).patientAccessHistory(WS, actor('t-b'), 'pat-1'), ForbiddenException);
    await rejects(() => reg(p).patientAccessHistory(WS, actor('assistant'), 'pat-1'), ForbiddenException);
  });

  it('CA3.4 OWNER difiere el aviso: sin aviso, auditado, oculto al titular, recordatorio a 30 días y liberación', async () => {
    const p = seed();
    const res: any = await svc(p).create(WS, actor('owner-c'), 'pat-1', body('LEGAL_REQUIREMENT', { deferNotice: true, deferReason: DEFER }));
    expect(store(p).notification).toHaveLength(0);
    expect(records(p)[0].notificationDeferredReason).toMatch(/^enc:v/);
    expect(store(p).auditLog.map((a: any) => a.action)).toContain('EXCEPTIONAL_ACCESS_NOTICE_DEFERRED');
    expect((await reg(p).patientAccessHistory(WS, actor('t-a'), 'pat-1') as any).accesses).toHaveLength(0);

    expect(await sendDeferredNoticeReminders(p, WS, new Date(Date.now() + 29 * 24 * HOUR))).toBe(0);
    expect(await sendDeferredNoticeReminders(p, WS, new Date(Date.now() + 31 * 24 * HOUR))).toBe(1);
    expect(store(p).notification.map((n: any) => n.userId).sort()).toEqual(['owner-c', 'owner-nc']);
    expect(json(store(p).notification)).not.toContain('Diferido por');

    await rejects(() => reg(p).releaseNotice(WS, actor('admin-nc'), res.id), ForbiddenException);
    await reg(p).releaseNotice(WS, actor('owner-nc'), res.id);
    expect(store(p).notification.filter((n: any) => n.userId === 't-a')).toHaveLength(1);
    expect((await reg(p).patientAccessHistory(WS, actor('t-a'), 'pat-1') as any).accesses).toHaveLength(1);
  });

  it('CA3.4 diferir: ADMIN → 403; código no permitido → 400', async () => {
    const p = seed();
    await rejects(() => svc(p).create(WS, actor('admin-nc'), 'pat-1', body('LEGAL_REQUIREMENT', { deferNotice: true, deferReason: DEFER })), ForbiddenException);
    await rejects(() => svc(p).create(WS, actor('owner-c'), 'pat-1', body('CUSTODY', { deferNotice: true, deferReason: DEFER })), BadRequestException);
    expect(records(p)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------
describe('H4 · registro y revisión del OWNER', () => {
  it('CA4.1 OWNER ve todo, ADMIN solo lo suyo, THERAPIST/ASSISTANT 403; nunca texto', async () => {
    const p = seed();
    await svc(p).create(WS, actor('owner-c'), 'pat-1', body());
    await svc(p).create(WS, actor('admin-nc'), 'pat-1', body('DATA_INCIDENT', { justification: 'Ficha ficticia duplicada por error de alta en recepción.' }));
    const all: any = await reg(p).list(WS, actor('owner-nc'));
    expect(all.accesses).toHaveLength(2);
    const own: any = await reg(p).list(WS, actor('admin-nc'));
    expect(own.accesses.map((a: any) => a.actorId)).toEqual(['admin-nc']);
    expect(json([all, own])).not.toMatch(/Juzgado|duplicada|justification/);
    await rejects(() => reg(p).list(WS, actor('t-a')), ForbiddenException);
    await rejects(() => reg(p).list(WS, actor('assistant')), ForbiddenException);
  });

  it('CA4.2 [Ver explicación]: solo OWNER, con motivo de lectura auditado', async () => {
    const p = seed();
    const res: any = await svc(p).create(WS, actor('owner-c'), 'pat-1', body());
    await rejects(() => reg(p).readJustification(WS, actor('admin-nc'), res.id, 'INTERNAL_AUDIT'), ForbiddenException);
    const out = await reg(p).readJustification(WS, actor('owner-nc'), res.id, 'CLAIM_OR_AUTHORITY');
    expect(out.justification).toBe(JUSTIFICATION);
    const audit = store(p).auditLog.find((a: any) => a.action === 'EXCEPTIONAL_ACCESS_JUSTIFICATION_READ');
    expect(audit).toMatchObject({ actorId: 'owner-nc', entityId: res.id, metadata: { purpose: 'CLAIM_OR_AUTHORITY', blocked: false } });
    expect(json(audit)).not.toContain('Juzgado');
  });

  it('CA4.3 VITAL_URGENCY → revisión en 72 h; no bloquea el acceso', async () => {
    const p = seed();
    await svc(p).create(WS, actor('owner-c'), 'pat-1', body('VITAL_URGENCY', { justification: 'Urgencia ficticia: el profesional habitual no está localizable hoy.' }));
    const [row] = records(p);
    expect(row.ownerReviewDueAt.getTime() - row.createdAt.getTime()).toBe(72 * HOUR);
    expect(json(await patients(p).getClinicalHistory(WS, actor('owner-c'), 'pat-1'))).toContain(M.history);
    expect(((await reg(p).list(WS, actor('owner-nc'))) as any).accesses[0].status).toBe('URGENCY_PENDING_REVIEW');
  });

  const urgency = () => body('VITAL_URGENCY', { justification: 'Urgencia ficticia: el profesional habitual no está localizable hoy.' });

  it('CA4.4 + §9.1 b: con varios OWNER al crear, quien accedió no se revisa; lo revisa otro', async () => {
    const p = seed();
    const res: any = await svc(p).create(WS, actor('owner-c'), 'pat-1', urgency());
    await rejects(() => reg(p).reviewAccess(WS, actor('owner-c'), res.id, 'CORRECT'), ForbiddenException);
    await rejects(() => reg(p).reviewAccess(WS, actor('admin-nc'), res.id, 'CORRECT'), ForbiddenException);
    const out = await reg(p).reviewAccess(WS, actor('owner-nc'), res.id, 'INCIDENT');
    expect(out).toEqual({ reviewed: true, selfReview: false, lastOwnerStanding: false });
    expect(records(p)[0]).toMatchObject({ reviewedById: 'owner-nc', reviewOutcome: 'INCIDENT', selfReview: false });
  });

  it('§9.1 c: si los demás OWNER se van y solo queda quien accedió, se revisa él mismo (selfReview, auditado)', async () => {
    const p = seed();
    const res: any = await svc(p).create(WS, actor('owner-c'), 'pat-1', urgency());
    store(p).workspaceMember = store(p).workspaceMember.filter((m: any) => m.userId !== 'owner-nc');
    const out = await reg(p).reviewAccess(WS, actor('owner-c'), res.id, 'CORRECT');
    expect(out).toEqual({ reviewed: true, selfReview: true, lastOwnerStanding: true });
    const audit = store(p).auditLog.find((a: any) => a.action === 'EXCEPTIONAL_ACCESS_REVIEWED');
    expect(audit.metadata).toEqual({ outcome: 'CORRECT', selfReview: true, lastOwnerStanding: true });
  });

  it('CA4.5 un único OWNER al crear: se revisa a sí mismo aunque después entren más', async () => {
    const p = seed();
    const nc = store(p).workspaceMember.find((m: any) => m.userId === 'owner-nc');
    nc.role = 'ADMIN';
    const res: any = await svc(p).create(WS, actor('owner-c'), 'pat-1', urgency());
    expect(records(p)[0].ownerCountAtCreation).toBe(1);
    nc.role = 'OWNER';
    const out = await reg(p).reviewAccess(WS, actor('owner-c'), res.id, 'CORRECT');
    expect(out).toMatchObject({ reviewed: true, selfReview: true, lastOwnerStanding: false });
    await rejects(() => reg(p).reviewAccess(WS, actor('owner-nc'), res.id, 'CORRECT'), BadRequestException);
  });

  it('CA4.4 autoapertura de proceso sobre historia ajena (H6): la revisa otro OWNER', async () => {
    const p = seed();
    await new ClinicalProcessesService(p).create(WS, actor('owner-c'), { patientId: 'pat-1', title: 'Proceso', therapistId: 'owner-c', openingReasonCode: 'SUBSTITUTION' } as any);
    const [opening] = store(p).clinicalProcessOpening;
    await rejects(() => reg(p).reviewOpening(WS, actor('owner-c'), opening.id, 'CORRECT'), ForbiddenException);
    expect(await reg(p).reviewOpening(WS, actor('owner-nc'), opening.id, 'CORRECT')).toMatchObject({ selfReview: false });
    const listed: any = await reg(p).list(WS, actor('owner-nc'));
    expect(listed.openings).toEqual([expect.objectContaining({ type: 'PROCESS_OPENING_OVER_HISTORY', reasonCode: 'SUBSTITUTION', pendingReview: false })]);
  });

  it('CA4.6 paciente bloqueado: el acceso pasa a bloqueado (no se borra) y la explicación solo con motivo de bloqueo', async () => {
    const p = seed();
    const res: any = await svc(p).create(WS, actor('owner-c'), 'pat-1', body());
    await patients(p).block(WS, actor('owner-nc'), 'pat-1');
    expect(records(p)).toHaveLength(1);
    expect(records(p)[0].blockedAt).toBeInstanceOf(Date);
    await rejects(() => read(p), ForbiddenException);
    await rejects(() => reg(p).readJustification(WS, actor('owner-nc'), res.id, 'INTERNAL_AUDIT'), ForbiddenException);
    expect((await reg(p).readJustification(WS, actor('owner-nc'), res.id, 'PATIENT_REQUEST')).justification).toBe(JUSTIFICATION);
    expect(((await reg(p).list(WS, actor('owner-nc'))) as any).accesses[0].status).toBe('BLOCKED');
  });

  const read = (p: any) => patients(p).getClinicalHistory(WS, actor('owner-c'), 'pat-1');
});

// ------------------------------------------------------------------------------------------
describe('H5 · motivos antiguos en claro (CA5.1)', () => {
  const LEGACY = 'Motivo antiguo ficticio escrito en claro';

  function legacyDb() {
    const p = seed();
    store(p).auditLog.push(
      { id: 'audit-legacy', workspaceId: WS, actorId: 'owner-c', action: 'EXCEPTIONAL_CLINICAL_ACCESS', entityType: 'Patient', entityId: 'pat-1', metadata: { reason: LEGACY, role: 'OWNER' }, createdAt: d('2026-09-01') },
      { id: 'audit-other', workspaceId: WS, actorId: 'owner-c', action: 'PATIENT_UPDATED', entityType: 'Patient', entityId: 'pat-1', metadata: { updatedFields: ['phone'] }, createdAt: d('2026-09-01') },
    );
    return p;
  }

  it('mueve el texto cifrado (DATA_INCIDENT, migrado, sin conceder acceso) y quita metadata.reason; idempotente', async () => {
    const p = legacyDb();
    expect(await migrateLegacyExceptionalReasons(p, { dryRun: true })).toEqual({ found: 1, migrated: 0, skipped: 0 });
    expect(records(p)).toHaveLength(0);

    expect(await migrateLegacyExceptionalReasons(p)).toEqual({ found: 1, migrated: 1, skipped: 0 });
    const [row] = records(p);
    expect(row).toMatchObject({ reasonCode: 'DATA_INCIDENT', migratedFromAuditLogId: 'audit-legacy', authSessionId: null, closeReason: 'MIGRATED', workspaceId: WS });
    expect(row.justification).toMatch(/^enc:v/);
    const legacy = store(p).auditLog.find((a: any) => a.id === 'audit-legacy');
    expect(legacy.metadata).toEqual({ reasonCode: 'DATA_INCIDENT', role: 'OWNER', exceptionalAccessId: row.id, migrated: true });
    expect(json(store(p).auditLog)).not.toContain(LEGACY);

    expect(await migrateLegacyExceptionalReasons(p)).toEqual({ found: 0, migrated: 0, skipped: 0 });
    expect(records(p)).toHaveLength(1);

    // No concede nada aunque coincidieran sesión y plazo, y no sale en "Accesos de otras personas".
    Object.assign(row, { authSessionId: 'sid-owner-c', expiresAt: new Date(Date.now() + HOUR), closedAt: null });
    await rejects(() => patients(p).getClinicalHistory(WS, actor('owner-c'), 'pat-1'), ForbiddenException);
    expect((await reg(p).patientAccessHistory(WS, actor('t-a'), 'pat-1') as any).accesses).toHaveLength(0);
    // El OWNER puede leer el texto migrado con lectura auditada.
    expect((await reg(p).readJustification(WS, actor('owner-nc'), row.id, 'INTERNAL_AUDIT')).justification).toBe(LEGACY);
  });
});
