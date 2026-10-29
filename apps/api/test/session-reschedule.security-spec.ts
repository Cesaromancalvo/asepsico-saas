import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SessionsController } from '../src/sessions/sessions.controller';
import { SessionsService } from '../src/sessions/sessions.service';
import { RescheduleSessionTimesDto } from '../src/sessions/dto/reschedule-session.dto';
import { encryptField } from '../src/common/crypto/field-encryption';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * «Mover cita» (PATCH /sessions/:id/reschedule). Reglas:
 *  - OWNER/ADMIN/ASSISTANT mueven cualquier cita del espacio; THERAPIST solo las suyas (403 auditado).
 *  - Acotado al workspace: una cita de otro espacio es 404 y no se toca.
 *  - Solo citas SCHEDULED que no han empezado, a una hora futura, sin solapes (mismo lock de agenda).
 *  - Las solicitudes del portal pendientes sobre esa cita se rechazan con CONTACT_PRACTICE.
 *  - Auditoría SESSION_RESCHEDULED con hora antigua y nueva, sin contenido clínico, en la misma
 *    transacción (si falla, nada cambia).
 * Datos 100 % ficticios.
 */

const WS = 'ws-1';
const WS2 = 'ws-2';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Base redondeada a la hora para que las franjas sean legibles.
const BASE = Math.ceil(Date.now() / HOUR) * HOUR;
const at = (days: number, hours = 10) => new Date(BASE + days * DAY + hours * HOUR);
const plus = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
const NOTES_MARK = 'MARK-NOTA-CLINICA-RESCHEDULE';
const SUMMARY_MARK = 'MARK-RESUMEN-RESCHEDULE';

type Role = 'THERAPIST' | 'OWNER' | 'ADMIN' | 'ASSISTANT';
const actor = (sub: string, role: Role, workspaceId = WS) => ({ sub, role, workspaceId, email: `${sub}@example.com` }) as any;

function seed(extra: { session?: any[]; appointmentRequest?: any[] } = {}) {
  const member = (userId: string, role: Role, isClinician: boolean, workspaceId = WS) => ({ id: `m-${userId}`, workspaceId, userId, role, isClinician });
  const proc = (id: string, therapistId: string, status: string, patientId = 'pat-1', workspaceId = WS) => ({
    id, workspaceId, patientId, therapistId, status, title: 'Proceso ficticio', consultationReason: null, goals: null, internalNotes: null,
    modality: 'ONLINE', frequency: 'WEEKLY', startedAt: new Date('2026-01-01'), endedAt: null, pausedAt: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  });
  const ses = (id: string, therapistId: string, clinicalProcessId: string, startsAt: Date, more: Record<string, unknown> = {}) => ({
    id, workspaceId: WS, patientId: 'pat-1', therapistId, clinicalProcessId, startsAt, endsAt: plus(startsAt, 50),
    status: 'SCHEDULED', type: 'INDIVIDUAL', location: null, videoCallUrl: null,
    notes: encryptField(NOTES_MARK), internalSummary: encryptField(SUMMARY_MARK),
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...more,
  });
  return fakeClinicalDb({
    workspace: [{ id: WS, timeZone: 'Europe/Madrid' }, { id: WS2, timeZone: 'Europe/Madrid' }],
    workspaceMember: [
      member('t-a', 'THERAPIST', true), member('t-b', 'THERAPIST', true), member('owner', 'OWNER', false),
      member('admin', 'ADMIN', false), member('assistant', 'ASSISTANT', false), member('t-ws2', 'THERAPIST', true, WS2),
      member('owner-ws2', 'OWNER', false, WS2),
    ],
    patient: [
      { id: 'pat-1', workspaceId: WS, firstName: 'Paciente', lastName: 'Ficticio', status: 'ACTIVE', deletedAt: null },
      { id: 'pat-2', workspaceId: WS, firstName: 'Otra', lastName: 'Ficticia', status: 'ACTIVE', deletedAt: null },
      { id: 'pat-ws2', workspaceId: WS2, firstName: 'Ajeno', lastName: 'Ficticio', status: 'ACTIVE', deletedAt: null },
    ],
    clinicalProcess: [
      proc('proc-a', 't-a', 'ACTIVE'), proc('proc-b', 't-b', 'ACTIVE'), proc('proc-a2', 't-a', 'ACTIVE', 'pat-2'),
      proc('proc-closed', 't-a', 'CLOSED'), proc('proc-ws2', 't-ws2', 'ACTIVE', 'pat-ws2', WS2),
    ],
    session: [
      ses('ses-a', 't-a', 'proc-a', at(3)),
      ses('ses-a-other', 't-a', 'proc-a2', at(4), { patientId: 'pat-2' }),
      ses('ses-b', 't-b', 'proc-b', at(5)),
      ses('ses-a-past', 't-a', 'proc-a', at(-2)),
      ses('ses-a-done', 't-a', 'proc-a', at(-3), { status: 'COMPLETED' }),
      ses('ses-a-cancelled', 't-a', 'proc-a', at(6), { status: 'CANCELLED' }),
      ses('ses-a-closed-proc', 't-a', 'proc-closed', at(7)),
      { ...ses('ses-ws2', 't-ws2', 'proc-ws2', at(3)), workspaceId: WS2, patientId: 'pat-ws2' },
      ...(extra.session ?? []),
    ],
    appointmentRequest: extra.appointmentRequest ?? [],
  } as any);
}

const service = (prisma: any) => new SessionsService(prisma);
const sessionRow = (prisma: any, id: string) => prisma.__store.session.find((row: any) => row.id === id);
const audits = (prisma: any, action: string) => prisma.__store.auditLog.filter((row: any) => row.action === action);
const codeOf = (error: any) => error?.getResponse?.()?.code;
const statusOf = (error: any) => error?.getStatus?.();
const body = (startsAt: Date, endsAt = plus(startsAt, 50)) => ({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });

async function failMove(prisma: any, who: any, id: string, startsAt: Date, endsAt?: Date) {
  const before = { ...sessionRow(prisma, id) };
  const error = await service(prisma).reschedule(who.workspaceId, who, id, body(startsAt, endsAt)).then(() => null, (e) => e);
  expect(error).not.toBeNull();
  const after = sessionRow(prisma, id);
  if (after) {
    expect(after.startsAt).toEqual(before.startsAt);
    expect(after.endsAt).toEqual(before.endsAt);
  }
  expect(audits(prisma, 'SESSION_RESCHEDULED')).toHaveLength(0);
  return error;
}

// -----------------------------------------------------------------------------------------------
describe('Mover cita: permisos por rol', () => {
  it.each([
    ['OWNER', 'owner'], ['ADMIN', 'admin'], ['ASSISTANT', 'assistant'], ['THERAPIST', 't-a'],
  ] as const)('%s puede mover la cita (THERAPIST solo la suya)', async (role, sub) => {
    const prisma = seed();
    const target = at(10, 12);
    await service(prisma).reschedule(WS, actor(sub, role), 'ses-a', body(target, plus(target, 60)));
    expect(sessionRow(prisma, 'ses-a').startsAt).toEqual(target);
    expect(sessionRow(prisma, 'ses-a').endsAt).toEqual(plus(target, 60));
    expect(audits(prisma, 'SESSION_RESCHEDULED')).toHaveLength(1);
  });

  it('ASSISTANT recibe la vista administrativa: sin notas ni resumen interno', async () => {
    const prisma = seed();
    const result = await service(prisma).reschedule(WS, actor('assistant', 'ASSISTANT'), 'ses-a', body(at(10)));
    const json = JSON.stringify(result);
    expect(json).not.toContain(NOTES_MARK);
    expect(json).not.toContain(SUMMARY_MARK);
    expect(result).not.toHaveProperty('notes');
  });

  it('un THERAPIST no puede mover la cita de otro profesional: 403 NOT_OWN_SESSION, auditado, nada cambia', async () => {
    const prisma = seed();
    const error = await failMove(prisma, actor('t-b', 'THERAPIST'), 'ses-a', at(10));
    expect(statusOf(error)).toBe(403);
    expect(codeOf(error)).toBe('NOT_OWN_SESSION');
    const denied = audits(prisma, 'CLINICAL_ACCESS_DENIED');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ workspaceId: WS, actorId: 't-b' });
    expect(JSON.stringify(denied)).not.toContain(NOTES_MARK);
  });

  it('un rol desconocido no mueve nada', async () => {
    const prisma = seed();
    await expect(service(prisma).reschedule(WS, actor('x', 'PATIENT' as any), 'ses-a', body(at(10)))).rejects.toBeDefined();
    expect(sessionRow(prisma, 'ses-a').startsAt).toEqual(at(3));
  });
});

describe('Mover cita: multi-tenant', () => {
  it('una cita de otro workspace es 404 SESSION_NOT_FOUND y no se toca', async () => {
    const prisma = seed();
    const error = await failMove(prisma, actor('owner', 'OWNER'), 'ses-ws2', at(10));
    expect(statusOf(error)).toBe(404);
    expect(codeOf(error)).toBe('SESSION_NOT_FOUND');
  });

  it('el OWNER de otro workspace no mueve una cita de este (404)', async () => {
    const prisma = seed();
    const error = await failMove(prisma, actor('owner-ws2', 'OWNER', WS2), 'ses-a', at(10));
    expect(codeOf(error)).toBe('SESSION_NOT_FOUND');
  });

  it('todas las lecturas y escrituras de la operación van acotadas por workspaceId', async () => {
    const prisma = seed();
    await service(prisma).reschedule(WS, actor('owner', 'OWNER'), 'ses-a', body(at(10)));
    for (const call of prisma.session.updateMany.mock.calls) expect(call[0].where).toMatchObject({ id: 'ses-a', workspaceId: WS, status: 'SCHEDULED' });
    for (const call of prisma.session.findFirst.mock.calls) expect(call[0].where.workspaceId).toBe(WS);
    for (const call of prisma.clinicalProcess.updateMany.mock.calls) expect(call[0].where.workspaceId).toBe(WS);
    for (const call of prisma.appointmentRequest.findMany.mock.calls) expect(call[0].where.workspaceId).toBe(WS);
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(sessionRow(prisma, 'ses-ws2').startsAt).toEqual(at(3));
  });
});

describe('Mover cita: validaciones de agenda', () => {
  it('toma el lock de la agenda del profesional (el mismo que la aprobación de solicitudes)', async () => {
    const prisma = seed();
    await service(prisma).reschedule(WS, actor('owner', 'OWNER'), 'ses-a', body(at(10)));
    expect(prisma.__locks).toContain(`schedule:${WS}:t-a`);
  });

  it('solape con otra cita del mismo profesional → 400 SESSION_OVERLAP', async () => {
    const prisma = seed();
    const error = await failMove(prisma, actor('owner', 'OWNER'), 'ses-a', plus(at(4), 20));
    expect(statusOf(error)).toBe(400);
    expect(codeOf(error)).toBe('SESSION_OVERLAP');
  });

  it('a la hora de una cita de OTRO profesional sí se puede (no es su agenda)', async () => {
    const prisma = seed();
    await service(prisma).reschedule(WS, actor('owner', 'OWNER'), 'ses-a', body(at(5)));
    expect(sessionRow(prisma, 'ses-a').startsAt).toEqual(at(5));
  });

  it('una cita cancelada no ocupa el hueco', async () => {
    const prisma = seed();
    await service(prisma).reschedule(WS, actor('owner', 'OWNER'), 'ses-a', body(at(6)));
    expect(sessionRow(prisma, 'ses-a').startsAt).toEqual(at(6));
  });

  it('mover 15 minutos (solapando consigo misma) o alargar la duración está permitido', async () => {
    const prisma = seed();
    await service(prisma).reschedule(WS, actor('t-a', 'THERAPIST'), 'ses-a', body(plus(at(3), 15)));
    expect(sessionRow(prisma, 'ses-a').startsAt).toEqual(plus(at(3), 15));
    await service(prisma).reschedule(WS, actor('t-a', 'THERAPIST'), 'ses-a', body(plus(at(3), 15), plus(at(3), 105)));
    expect(sessionRow(prisma, 'ses-a').endsAt).toEqual(plus(at(3), 105));
  });

  it('a una hora pasada → 400 START_IN_PAST', async () => {
    const prisma = seed();
    const error = await failMove(prisma, actor('owner', 'OWNER'), 'ses-a', new Date(Date.now() - HOUR));
    expect(codeOf(error)).toBe('START_IN_PAST');
  });

  it('una cita que ya empezó o pasó (aunque siga SCHEDULED) → 409 SESSION_ALREADY_STARTED', async () => {
    const prisma = seed();
    const error = await failMove(prisma, actor('owner', 'OWNER'), 'ses-a-past', at(10));
    expect(statusOf(error)).toBe(409);
    expect(codeOf(error)).toBe('SESSION_ALREADY_STARTED');
  });

  it.each(['ses-a-done', 'ses-a-cancelled'])('cita cerrada o cancelada (%s) → 409 SESSION_NOT_SCHEDULED', async (id) => {
    const prisma = seed();
    const error = await failMove(prisma, actor('owner', 'OWNER'), id, at(10));
    expect(statusOf(error)).toBe(409);
    expect(codeOf(error)).toBe('SESSION_NOT_SCHEDULED');
  });

  it('proceso clínico cerrado → 400 PROCESS_NOT_ACTIVE', async () => {
    const prisma = seed();
    const error = await failMove(prisma, actor('owner', 'OWNER'), 'ses-a-closed-proc', at(10));
    expect(statusOf(error)).toBe(400);
    expect(codeOf(error)).toBe('PROCESS_NOT_ACTIVE');
  });

  it('fin anterior al inicio o más de 12 h → 400 INVALID_RANGE; misma hora → 400 NO_CHANGE', async () => {
    const prisma = seed();
    expect(codeOf(await failMove(prisma, actor('owner', 'OWNER'), 'ses-a', at(10), at(9)))).toBe('INVALID_RANGE');
    expect(codeOf(await failMove(prisma, actor('owner', 'OWNER'), 'ses-a', at(10), plus(at(10), 13 * 60)))).toBe('INVALID_RANGE');
    expect(codeOf(await failMove(prisma, actor('owner', 'OWNER'), 'ses-a', at(3), plus(at(3), 50)))).toBe('NO_CHANGE');
  });

  it('el DTO exige inicio y fin con zona horaria y no admite notas', async () => {
    const errors = async (input: object) => validate(plainToInstance(RescheduleSessionTimesDto, input), { whitelist: true, forbidNonWhitelisted: true });
    expect(await errors({ startsAt: '2026-11-03T19:30:00+01:00', endsAt: '2026-11-03T20:20:00+01:00' })).toHaveLength(0);
    expect(await errors({ startsAt: '2026-11-03T18:30:00Z', endsAt: '2026-11-03T19:20:00.000Z' })).toHaveLength(0);
    expect((await errors({ startsAt: '2026-11-03T19:30:00', endsAt: '2026-11-03T20:20:00' })).length).toBeGreaterThan(0);
    expect((await errors({ startsAt: '2026-11-03T19:30:00+01:00' })).length).toBeGreaterThan(0);
    expect((await errors({ startsAt: '2026-11-03T19:30:00+01:00', endsAt: '2026-11-03T20:20:00+01:00', notes: 'x' })).length).toBeGreaterThan(0);
  });

  it('la ruta es PATCH /sessions/:id/reschedule', () => {
    const handler = SessionsController.prototype.move;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/reschedule');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PATCH);
  });
});

describe('Mover cita: solicitudes del portal', () => {
  const request = (id: string, more: Record<string, unknown>) => ({
    id, workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', clinicalProcessId: 'proc-a', sessionId: null,
    type: 'NEW', status: 'PENDING', startsAt: null, endsAt: null, heldStartsAt: null,
    expiresAt: at(20), createdAt: new Date(), resolvedAt: null, ...more,
  });

  it('las pendientes sobre ESTA cita (cambio y cancelación) se rechazan con CONTACT_PRACTICE y el hueco retenido se libera', async () => {
    const held = at(9);
    const prisma = seed({
      appointmentRequest: [
        request('req-move', { type: 'RESCHEDULE', sessionId: 'ses-a', startsAt: held, endsAt: plus(held, 50), heldStartsAt: held }),
        request('req-cancel', { type: 'CANCEL', sessionId: 'ses-a' }),
        request('req-other', { type: 'CANCEL', sessionId: 'ses-a-other', patientId: 'pat-2' }),
      ],
    });
    // Se mueve justo al hueco que pedía el paciente: su propia solicitud no lo bloquea.
    await service(prisma).reschedule(WS, actor('owner', 'OWNER'), 'ses-a', body(held));
    expect(sessionRow(prisma, 'ses-a').startsAt).toEqual(held);

    const rows = prisma.__store.appointmentRequest;
    for (const id of ['req-move', 'req-cancel']) {
      expect(rows.find((r: any) => r.id === id)).toMatchObject({ status: 'REJECTED', rejectionReason: 'CONTACT_PRACTICE', heldStartsAt: null, resolvedById: 'owner' });
    }
    expect(rows.find((r: any) => r.id === 'req-other').status).toBe('PENDING');

    const rejected = audits(prisma, 'APPOINTMENT_REQUEST_REJECTED');
    expect(rejected.map((a: any) => a.entityId).sort()).toEqual(['req-cancel', 'req-move']);
    expect(rejected[0].metadata).toMatchObject({ cause: 'SESSION_RESCHEDULED_BY_STAFF', sessionId: 'ses-a' });
    expect(audits(prisma, 'SESSION_RESCHEDULED')[0].metadata.rejectedRequestIds.sort()).toEqual(['req-cancel', 'req-move']);
    // Aviso genérico en el portal (sin fecha, hora ni nombre); ningún correo.
    const notices = prisma.__store.notification.filter((n: any) => n.type === 'APPOINTMENT_REQUEST_UPDATE');
    expect(notices).toHaveLength(2);
    // Más el aviso de la hora nueva (uno solo).
    expect(prisma.__store.notification.filter((n: any) => n.title === 'Tu cita ha cambiado')).toHaveLength(1);
    for (const notice of notices) expect(`${notice.title} ${notice.body}`).not.toMatch(/\d{1,2}:\d{2}|Paciente|Ficticio/);
  });

  it('una solicitud pendiente de OTRO paciente en la franja nueva → 409 SLOT_NOT_AVAILABLE y todo se revierte', async () => {
    const slot = at(11);
    const prisma = seed({
      appointmentRequest: [
        request('req-new-p2', { patientId: 'pat-2', clinicalProcessId: 'proc-a2', startsAt: slot, endsAt: plus(slot, 50), heldStartsAt: slot }),
        request('req-cancel', { type: 'CANCEL', sessionId: 'ses-a' }),
      ],
    });
    const error = await failMove(prisma, actor('owner', 'OWNER'), 'ses-a', plus(slot, 10));
    expect(statusOf(error)).toBe(409);
    expect(codeOf(error)).toBe('SLOT_NOT_AVAILABLE');
    // La cancelación pendiente de esta cita NO se ha rechazado (rollback de la transacción).
    expect(prisma.__store.appointmentRequest.find((r: any) => r.id === 'req-cancel').status).toBe('PENDING');
    expect(audits(prisma, 'APPOINTMENT_REQUEST_REJECTED')).toHaveLength(0);
  });
});

describe('Mover cita: PATCH heredado sin hora nueva', () => {
  it.each([
    ['body vacío', {}],
    ['solo notas', { notes: 'Nota ficticia' }],
  ])('%s en el PATCH heredado: 400 NO_CHANGE, sin auditoría ni aviso', async (_label, dto) => {
    const prisma = seed();
    const error = await service(prisma).reschedule(WS, actor('t-a', 'THERAPIST'), 'ses-a', dto as any).then(() => null, (e) => e);
    expect(statusOf(error)).toBe(400);
    expect(codeOf(error)).toBe('NO_CHANGE');
    expect(audits(prisma, 'SESSION_RESCHEDULED')).toHaveLength(0);
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(prisma.__store.notification).toHaveLength(0);
  });
});

describe('Mover cita: aviso al paciente en el portal', () => {
  it('crea un aviso SOLO para ese paciente, con día y hora en la zona del espacio y sin datos clínicos', async () => {
    const prisma = seed();
    // 3 de noviembre de 2026, 18:30 UTC = 19:30 en Madrid (CET).
    const target = new Date('2026-11-03T18:30:00Z');
    jest.useFakeTimers({ now: new Date('2026-10-29T09:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      await service(prisma).reschedule(WS, actor('assistant', 'ASSISTANT'), 'ses-a', body(target));
    } finally {
      jest.useRealTimers();
    }
    const notices = prisma.__store.notification;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ workspaceId: WS, audience: 'PATIENT', patientId: 'pat-1', status: 'SENT', actionUrl: '/portal', title: 'Tu cita ha cambiado' });
    expect(notices[0].userId).toBeUndefined();
    expect(notices[0].body).toBe('Tu cita ha cambiado: nueva fecha martes, 3 de noviembre, 19:30.');
    const json = JSON.stringify(notices);
    for (const forbidden of [NOTES_MARK, SUMMARY_MARK, 'Proceso ficticio', 'Profesional', 'INDIVIDUAL', 't-a', 'proc-a']) expect(json).not.toContain(forbidden);
    // Ningún envío fuera del portal.
    expect(prisma.__store.notificationDelivery ?? []).toHaveLength(0);
  });

  it('el aviso se lee por el portal del paciente (o su tutor) y no por el de otro paciente ni otro espacio', async () => {
    const { NotificationsService } = await import('../src/notifications/notifications.service');
    const prisma = seed();
    prisma.__store.patientPortalAccount = [
      { id: 'acc-p1', workspaceId: WS, patientId: 'pat-1', isActive: true },
      { id: 'acc-p1-tutor', workspaceId: WS, patientId: 'pat-1', isActive: true, accessorType: 'GUARDIAN' },
      { id: 'acc-p2', workspaceId: WS, patientId: 'pat-2', isActive: true },
      { id: 'acc-ws2', workspaceId: WS2, patientId: 'pat-ws2', isActive: true },
    ];
    for (const name of ['patientPortalAccount']) {
      prisma[name] = { findFirst: jest.fn(async ({ where }: any) => prisma.__store[name].find((r: any) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null) };
    }
    await service(prisma).reschedule(WS, actor('owner', 'OWNER'), 'ses-a', body(at(10)));
    const notifications = new NotificationsService(prisma);
    const read = (workspaceId: string, patientId: string, portalAccountId: string) => notifications.listPatient({ workspaceId, patientId, portalAccountId });
    const titles = (rows: any[]) => rows.map((r) => r.title);
    expect(titles(await read(WS, 'pat-1', 'acc-p1'))).toContain('Tu cita ha cambiado');
    expect(titles(await read(WS, 'pat-1', 'acc-p1-tutor'))).toContain('Tu cita ha cambiado');
    expect(titles(await read(WS, 'pat-2', 'acc-p2'))).not.toContain('Tu cita ha cambiado');
    expect(titles(await read(WS2, 'pat-ws2', 'acc-ws2'))).not.toContain('Tu cita ha cambiado');
  });

  it('si el movimiento falla, no hay aviso', async () => {
    const prisma = seed();
    await failMove(prisma, actor('owner', 'OWNER'), 'ses-a', plus(at(4), 20));
    expect(prisma.__store.notification).toHaveLength(0);
  });
});

describe('Mover cita: auditoría', () => {
  it('SESSION_RESCHEDULED con hora antigua y nueva, actor y workspace, sin contenido clínico', async () => {
    const prisma = seed();
    const target = at(10, 17);
    await service(prisma).reschedule(WS, actor('t-a', 'THERAPIST'), 'ses-a', body(target, plus(target, 45)));
    const [audit] = audits(prisma, 'SESSION_RESCHEDULED');
    expect(audit).toMatchObject({ workspaceId: WS, actorId: 't-a', entityType: 'Session', entityId: 'ses-a' });
    expect(audit.metadata).toEqual({
      patientId: 'pat-1', therapistId: 't-a', source: 'AGENDA', rejectedRequestIds: [],
      from: { startsAt: at(3).toISOString(), endsAt: plus(at(3), 50).toISOString() },
      to: { startsAt: target.toISOString(), endsAt: plus(target, 45).toISOString() },
    });
    const json = JSON.stringify(prisma.__store.auditLog);
    expect(json).not.toContain(NOTES_MARK);
    expect(json).not.toContain(SUMMARY_MARK);
    expect(json).not.toContain('Proceso ficticio');
  });

  it('si la auditoría falla, la cita no se mueve y las solicitudes siguen pendientes (misma transacción)', async () => {
    const prisma = seed({ appointmentRequest: [{ id: 'req-cancel', workspaceId: WS, patientId: 'pat-1', therapistId: 't-a', sessionId: 'ses-a', type: 'CANCEL', status: 'PENDING', expiresAt: at(20) }] });
    const create = prisma.auditLog.create;
    prisma.auditLog.create = jest.fn(async (args: any) => {
      if (args?.data?.action === 'SESSION_RESCHEDULED') throw new Error('fallo de auditoría simulado');
      return create(args);
    });
    await expect(service(prisma).reschedule(WS, actor('owner', 'OWNER'), 'ses-a', body(at(10)))).rejects.toThrow('fallo de auditoría simulado');
    expect(sessionRow(prisma, 'ses-a').startsAt).toEqual(at(3));
    expect(prisma.__store.appointmentRequest[0].status).toBe('PENDING');
  });
});

// -----------------------------------------------------------------------------------------------
/**
 * Carreras contra PostgreSQL REAL (advisory locks de verdad). Igual que booking-race: solo con
 * RACE_DATABASE_URL apuntando a una base DESECHABLE ya migrada; con RACE_DATABASE_REQUIRED=1 su
 * ausencia hace fallar la suite. Escribe datos ficticios y no los borra.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de carrera de «Mover cita» no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;

describeDb('Mover cita: carreras (PostgreSQL real)', () => {
  jest.setTimeout(120_000);
  let prisma: PrismaClient;
  const run = `reschedule-race-${Date.now()}`;
  let workspaceId: string;
  let therapistId: string;
  let patientId: string;
  let processId: string;
  const therapist = () => ({ sub: therapistId, workspaceId, role: 'THERAPIST', email: `${run}@example.com` }) as any;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const workspace = await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}` } });
    const user = await prisma.user.create({ data: { email: `${run}@example.com`, passwordHash: 'hash-ficticio', firstName: 'Profesional', lastName: 'Ficticio' } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'THERAPIST', isClinician: true } });
    const patient = await prisma.patient.create({ data: { workspaceId: workspace.id, firstName: 'Paciente', lastName: 'Ficticio' } });
    const process = await prisma.clinicalProcess.create({ data: { workspaceId: workspace.id, patientId: patient.id, therapistId: user.id, title: 'Proceso ficticio' } });
    workspaceId = workspace.id; therapistId = user.id; patientId = patient.id; processId = process.id;
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('dos citas movidas a la vez al mismo hueco: solo una lo consigue, la otra 400 SESSION_OVERLAP', async () => {
    const sessions = new SessionsService(prisma as any);
    for (let round = 0; round < 8; round += 1) {
      const base = BASE + (round + 1) * 7 * DAY;
      const created = await Promise.all([0, 1, 2].map((slot) => prisma.session.create({
        data: { workspaceId, patientId, therapistId, clinicalProcessId: processId, startsAt: new Date(base + slot * 2 * HOUR), endsAt: new Date(base + slot * 2 * HOUR + 50 * 60_000) },
      })));
      const target = new Date(base + DAY);
      const results = await Promise.allSettled(created.map((s) => sessions.reschedule(workspaceId, therapist(), s.id, body(target))));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) if (r.status === 'rejected') expect(codeOf(r.reason)).toBe('SESSION_OVERLAP');
      const inTarget = await prisma.session.count({ where: { workspaceId, therapistId, status: 'SCHEDULED', startsAt: { lt: plus(target, 50) }, endsAt: { gt: target } } });
      expect(inTarget).toBe(1);
      expect(await prisma.auditLog.count({ where: { workspaceId, action: 'SESSION_RESCHEDULED', entityId: { in: created.map((s) => s.id) } } })).toBe(1);
    }
  });

  it('mover y crear a la vez en el mismo hueco: nunca quedan dos citas solapadas', async () => {
    const sessions = new SessionsService(prisma as any);
    for (let round = 0; round < 8; round += 1) {
      const base = BASE + (round + 20) * 7 * DAY;
      const existing = await prisma.session.create({ data: { workspaceId, patientId, therapistId, clinicalProcessId: processId, startsAt: new Date(base), endsAt: new Date(base + 50 * 60_000) } });
      const target = new Date(base + DAY);
      const results = await Promise.allSettled([
        sessions.reschedule(workspaceId, therapist(), existing.id, body(target)),
        sessions.create(workspaceId, therapist(), { patientId, clinicalProcessId: processId, ...body(target) } as any),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const inTarget = await prisma.session.count({ where: { workspaceId, therapistId, status: 'SCHEDULED', startsAt: { lt: plus(target, 50) }, endsAt: { gt: target } } });
      expect(inTarget).toBe(1);
    }
  });
});
