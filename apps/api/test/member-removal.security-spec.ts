import { BadRequestException, ConflictException, ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { AuthService } from '../src/auth/auth.service';
import { hashToken } from '../src/auth/token.util';
import { assertActiveSession } from '../src/common/auth/active-session';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { AvailabilityService } from '../src/scheduling/availability.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';
import { encryptField } from '../src/common/crypto/field-encryption';
import { MemberRemovalService } from '../src/workspace-members/member-removal.service';
import { WorkspaceMembersService } from '../src/workspace-members/workspace-members.service';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Historia B: baja de un miembro del equipo. Corte de acceso inmediato (también con un access token
 * aún vivo), reasignación en bloque y correcta, último OWNER protegido, autoría y auditoría
 * conservadas, y el otro workspace intacto. Datos 100 % ficticios.
 */

const WS = 'ws-1';
const WS2 = 'ws-2';
const FUTURE = new Date(Date.now() + 7 * 86_400_000);
const FUTURE_END = new Date(FUTURE.getTime() + 50 * 60_000);
const PAST = new Date(Date.now() - 7 * 86_400_000);
const PAST_END = new Date(PAST.getTime() + 50 * 60_000);
const LATER = new Date(Date.now() + 86_400_000 * 30);

const actor = (sub: string, role: string, workspaceId = WS) => ({ sub, workspaceId, role, email: `${sub}@example.test` }) as any;

function db(extra: Record<string, any[]> = {}) {
  const member = (id: string, workspaceId: string, userId: string, role: string, isClinician: boolean, day: number, more: any = {}) =>
    ({ id, workspaceId, userId, role, isClinician, createdAt: new Date(`2026-01-${String(day).padStart(2, '0')}`), ...more });
  return fakeClinicalDb({
    user: ['owner-1', 'owner-2', 'admin-1', 'admin-2', 'ther-1', 'ther-2', 'asst-1', 'owner-x'].map((id) => ({ id, email: `${id}@example.test`, firstName: 'Nombre', lastName: 'Ficticio' })),
    workspaceMember: [
      member('m-owner', WS, 'owner-1', 'OWNER', false, 1),
      member('m-admin', WS, 'admin-1', 'ADMIN', false, 2),
      member('m-admin2', WS, 'admin-2', 'ADMIN', true, 3),
      member('m-ther1', WS, 'ther-1', 'THERAPIST', true, 4),
      member('m-ther2', WS, 'ther-2', 'THERAPIST', true, 5),
      member('m-asst', WS, 'asst-1', 'ASSISTANT', false, 6),
      // ther-1 también trabaja en otro espacio: su baja aquí no debe tocar nada de allí.
      member('m-ws2-ther1', WS2, 'ther-1', 'THERAPIST', true, 7),
      member('m-ws2-owner', WS2, 'owner-x', 'OWNER', false, 8),
      ...(extra.workspaceMember ?? []),
    ],
    patient: [
      { id: 'pat-1', workspaceId: WS, firstName: 'Paciente', lastName: 'Uno', status: 'ACTIVE', deletedAt: null },
      { id: 'pat-2', workspaceId: WS, firstName: 'Paciente', lastName: 'Dos', status: 'ACTIVE', deletedAt: null },
      { id: 'pat-3', workspaceId: WS, firstName: 'Paciente', lastName: 'Tres', status: 'ACTIVE', deletedAt: null },
      { id: 'pat-x', workspaceId: WS2, firstName: 'Paciente', lastName: 'Ajeno', status: 'ACTIVE', deletedAt: null },
    ],
    clinicalProcess: [
      { id: 'p-active', workspaceId: WS, patientId: 'pat-1', therapistId: 'ther-1', status: 'ACTIVE' },
      { id: 'p-paused', workspaceId: WS, patientId: 'pat-2', therapistId: 'ther-1', status: 'PAUSED' },
      { id: 'p-closed', workspaceId: WS, patientId: 'pat-3', therapistId: 'ther-1', status: 'CLOSED' },
      { id: 'p-ws2', workspaceId: WS2, patientId: 'pat-x', therapistId: 'ther-1', status: 'ACTIVE' },
    ],
    session: [
      { id: 's-future', workspaceId: WS, patientId: 'pat-1', therapistId: 'ther-1', clinicalProcessId: 'p-active', status: 'SCHEDULED', startsAt: FUTURE, endsAt: FUTURE_END },
      { id: 's-past', workspaceId: WS, patientId: 'pat-1', therapistId: 'ther-1', clinicalProcessId: 'p-active', status: 'COMPLETED', startsAt: PAST, endsAt: PAST_END, notes: 'Nota ficticia' },
      { id: 's-past-scheduled', workspaceId: WS, patientId: 'pat-2', therapistId: 'ther-1', clinicalProcessId: 'p-paused', status: 'SCHEDULED', startsAt: PAST, endsAt: PAST_END },
      { id: 's-cancelled', workspaceId: WS, patientId: 'pat-1', therapistId: 'ther-1', clinicalProcessId: 'p-active', status: 'CANCELLED', startsAt: LATER, endsAt: LATER },
      { id: 's-ws2', workspaceId: WS2, patientId: 'pat-x', therapistId: 'ther-1', clinicalProcessId: 'p-ws2', status: 'SCHEDULED', startsAt: FUTURE, endsAt: FUTURE_END },
      ...(extra.session ?? []),
    ],
    refreshToken: [
      { id: 'rt-ws1', userId: 'ther-1', workspaceId: WS, tokenHash: hashToken('rt-ficticio-ws1'), family: 'f-1', revokedAt: null, expiresAt: LATER },
      { id: 'rt-ws2', userId: 'ther-1', workspaceId: WS2, tokenHash: hashToken('rt-ficticio-ws2'), family: 'f-2', revokedAt: null, expiresAt: LATER },
      { id: 'rt-other', userId: 'ther-2', workspaceId: WS, tokenHash: hashToken('rt-ficticio-otro'), family: 'f-3', revokedAt: null, expiresAt: LATER },
    ],
    exceptionalAccessJustification: [
      { id: 'ea-ws1', workspaceId: WS, patientId: 'pat-3', actorId: 'ther-1', closedAt: null },
      { id: 'ea-ws2', workspaceId: WS2, patientId: 'pat-x', actorId: 'ther-1', closedAt: null },
    ],
    appointmentRequest: [
      { id: 'ar-ws1', workspaceId: WS, patientId: 'pat-1', therapistId: 'ther-1', type: 'NEW', status: 'PENDING', startsAt: LATER, endsAt: LATER, heldStartsAt: LATER, expiresAt: LATER },
      { id: 'ar-ws2', workspaceId: WS2, patientId: 'pat-x', therapistId: 'ther-1', type: 'NEW', status: 'PENDING', startsAt: LATER, endsAt: LATER, heldStartsAt: LATER, expiresAt: LATER },
    ],
    therapistAvailability: [
      { id: 'ta-ws1', workspaceId: WS, therapistId: 'ther-1', portalBookingEnabled: true },
      { id: 'ta-ws2', workspaceId: WS2, therapistId: 'ther-1', portalBookingEnabled: true },
    ],
    termsAcceptance: [],
  });
}

const svc = (prisma: any) => new MemberRemovalService(prisma);
const row = (prisma: any, model: string, id: string) => prisma.__store[model].find((r: any) => r.id === id);
const memberOf = (prisma: any, workspaceId: string, userId: string) =>
  prisma.__store.workspaceMember.find((m: any) => m.workspaceId === workspaceId && m.userId === userId);

describe('POST /workspace-members/:userId/remove — baja con reasignación', () => {
  it('OWNER da de baja a un THERAPIST y reasigna: todo en una transacción, acotado al workspace y auditado con recuentos', async () => {
    const prisma = db();
    const result = await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2', reason: 'LEFT_PRACTICE' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__locks).toContain(`asepsico:member-removal:${WS}`);
    // Membresía conservada, con fecha, autor y motivo.
    const m = memberOf(prisma, WS, 'ther-1');
    expect(m).toMatchObject({ status: 'REMOVED', removedById: 'owner-1', removalReason: 'LEFT_PRACTICE' });
    expect(m.removedAt).toBeInstanceOf(Date);
    expect(prisma.__store.user.some((u: any) => u.id === 'ther-1')).toBe(true);

    // Reasignación: procesos vivos y citas futuras al destino; lo cerrado y lo pasado conserva autor.
    expect(row(prisma, 'clinicalProcess', 'p-active').therapistId).toBe('ther-2');
    expect(row(prisma, 'clinicalProcess', 'p-paused').therapistId).toBe('ther-2');
    expect(row(prisma, 'clinicalProcess', 'p-closed').therapistId).toBe('ther-1');
    expect(row(prisma, 'session', 's-future').therapistId).toBe('ther-2');
    expect(row(prisma, 'session', 's-past').therapistId).toBe('ther-1');
    expect(row(prisma, 'session', 's-past').notes).toBe('Nota ficticia');
    expect(row(prisma, 'session', 's-past-scheduled').therapistId).toBe('ther-1');
    expect(row(prisma, 'session', 's-cancelled').therapistId).toBe('ther-1');

    // Corte de acceso y cierres en ESTE workspace.
    expect(row(prisma, 'refreshToken', 'rt-ws1').revokedAt).toBeInstanceOf(Date);
    expect(row(prisma, 'refreshToken', 'rt-other').revokedAt).toBeNull();
    expect(row(prisma, 'exceptionalAccessJustification', 'ea-ws1')).toMatchObject({ closeReason: 'MEMBER_REMOVED' });
    expect(row(prisma, 'appointmentRequest', 'ar-ws1')).toMatchObject({ status: 'REJECTED', rejectionReason: 'CONTACT_PRACTICE', heldStartsAt: null, resolvedById: 'owner-1' });
    expect(row(prisma, 'therapistAvailability', 'ta-ws1').portalBookingEnabled).toBe(false);

    expect(result).toMatchObject({
      userId: 'ther-1', status: 'REMOVED', revokedSessions: 1, closedExceptionalAccesses: 1, rejectedAppointmentRequests: 1,
      reassignment: { toUserId: 'ther-2', processes: 2, futureSessions: 1 },
      pending: { activeProcesses: 0, pausedProcesses: 0, futureSessions: 0, pendingAppointmentRequests: 0 },
    });

    const audit = prisma.__store.auditLog.filter((a: any) => a.action.startsWith('MEMBER_'));
    expect(audit).toEqual([
      expect.objectContaining({ workspaceId: WS, actorId: 'owner-1', action: 'MEMBER_REMOVED', entityType: 'WorkspaceMember', entityId: 'm-ther1',
        metadata: expect.objectContaining({ userId: 'ther-1', role: 'THERAPIST', reason: 'LEFT_PRACTICE', revokedSessions: 1, closedExceptionalAccesses: 1, rejectedAppointmentRequests: 1 }) }),
      expect.objectContaining({ workspaceId: WS, actorId: 'owner-1', action: 'MEMBER_WORK_REASSIGNED', entityId: 'm-ther1',
        metadata: { fromUserId: 'ther-1', toUserId: 'ther-2', processes: 2, futureSessions: 1, processIds: ['p-active', 'p-paused'], sessionIds: ['s-future'], keptSessionIdsWithPrivateNotes: [] } }),
    ]);
    // Sin nombres de pacientes ni contenido clínico en la auditoría ni en la respuesta.
    const text = JSON.stringify([audit, result]);
    for (const forbidden of ['Paciente', 'Uno', 'Nota ficticia', 'pat-1']) expect(text).not.toContain(forbidden);
  });

  it('otro espacio no se ve afectado: la membresía, sesiones, procesos, citas y solicitudes de ws-2 siguen igual', async () => {
    const prisma = db();
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' });
    expect(memberOf(prisma, WS2, 'ther-1').status).toBeUndefined(); // sin tocar (ACTIVE por defecto)
    expect(row(prisma, 'refreshToken', 'rt-ws2').revokedAt).toBeNull();
    expect(row(prisma, 'exceptionalAccessJustification', 'ea-ws2').closedAt).toBeNull();
    expect(row(prisma, 'appointmentRequest', 'ar-ws2').status).toBe('PENDING');
    expect(row(prisma, 'therapistAvailability', 'ta-ws2').portalBookingEnabled).toBe(true);
    expect(row(prisma, 'clinicalProcess', 'p-ws2').therapistId).toBe('ther-1');
    expect(row(prisma, 'session', 's-ws2').therapistId).toBe('ther-1');
    expect(prisma.__store.auditLog.every((a: any) => a.workspaceId === WS)).toBe(true);
    await expect(assertActiveSession(prisma, { sub: 'ther-1', workspaceId: WS2, tv: 0 })).resolves.toBeUndefined();
  });

  it('el OWNER de otro espacio no puede ver ni dar de baja a un miembro de este (404 sin escribir)', async () => {
    const prisma = db();
    await expect(svc(prisma).remove(WS2, actor('owner-x', 'OWNER', WS2), 'ther-2', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc(prisma).preview(WS2, actor('owner-x', 'OWNER', WS2), 'ther-2')).rejects.toBeInstanceOf(NotFoundException);
    // Y desde este espacio, un usuario que solo es miembro del otro tampoco existe.
    await expect(svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'owner-x', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.workspaceMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it('"decidir después": sin destino los procesos y citas quedan a su nombre y se reasignan luego, una sola vez', async () => {
    const prisma = db();
    const result = await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', {});
    expect(result.reassignment).toBeNull();
    expect(result.pending).toEqual({ activeProcesses: 1, pausedProcesses: 1, futureSessions: 1, pendingAppointmentRequests: 0 });
    expect(row(prisma, 'clinicalProcess', 'p-active').therapistId).toBe('ther-1');

    const later = await svc(prisma).reassignWork(WS, actor('owner-1', 'OWNER'), 'ther-1', { toUserId: 'admin-2' });
    expect(later.reassignment).toEqual({ toUserId: 'admin-2', processes: 2, futureSessions: 1, keptSessionsWithPrivateNotes: 0 });
    expect(later.pending).toEqual({ activeProcesses: 0, pausedProcesses: 0, futureSessions: 0, pendingAppointmentRequests: 0 });
    expect(row(prisma, 'clinicalProcess', 'p-active').therapistId).toBe('admin-2');
    expect(row(prisma, 'clinicalProcess', 'p-closed').therapistId).toBe('ther-1');
  });

  it('reasignar el trabajo de un miembro que sigue activo → 409 sin escribir', async () => {
    const prisma = db();
    await expect(svc(prisma).reassignWork(WS, actor('owner-1', 'OWNER'), 'ther-1', { toUserId: 'ther-2' })).rejects.toMatchObject({ response: { code: 'MEMBER_STILL_ACTIVE' } });
    expect(row(prisma, 'clinicalProcess', 'p-active').therapistId).toBe('ther-1');
  });

  it.each([
    ['el propio miembro que se va', 'ther-1'],
    ['un ASSISTANT (no es clínico)', 'asst-1'],
    ['un ADMIN no clínico', 'admin-1'],
    ['un miembro de otro workspace', 'owner-x'],
    ['un usuario inexistente', 'nadie'],
  ])('destino no válido (%s) → 400 y no cambia NADA (rollback)', async (_label, target) => {
    const prisma = db();
    await expect(svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: target })).rejects.toMatchObject({ response: { code: 'INVALID_REASSIGN_TARGET' } });
    expect(memberOf(prisma, WS, 'ther-1').status).toBeUndefined();
    expect(row(prisma, 'refreshToken', 'rt-ws1').revokedAt).toBeNull();
    expect(row(prisma, 'clinicalProcess', 'p-active').therapistId).toBe('ther-1');
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it('un destino dado de baja tampoco vale', async () => {
    const prisma = db();
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-2', {});
    await expect(svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' })).rejects.toBeInstanceOf(BadRequestException);
    expect(row(prisma, 'clinicalProcess', 'p-active').therapistId).toBe('ther-1');
  });

  it('si una cita futura choca con la agenda del destino → 409 con el número de choques y nada cambia', async () => {
    const prisma = db({
      session: [{ id: 's-clash', workspaceId: WS, patientId: 'pat-3', therapistId: 'ther-2', status: 'SCHEDULED', startsAt: FUTURE, endsAt: FUTURE_END }],
    });
    const error = await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: 'REASSIGN_SCHEDULE_CONFLICT', conflicts: 1 });
    expect(memberOf(prisma, WS, 'ther-1').status).toBeUndefined();
    expect(row(prisma, 'session', 's-future').therapistId).toBe('ther-1');
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it('si el destino ya tiene un proceso abierto con alguno de esos pacientes → 409 REASSIGN_PROCESS_CONFLICT y nada cambia', async () => {
    const prisma = db();
    prisma.__store.clinicalProcess.push({ id: 'p-dest', workspaceId: WS, patientId: 'pat-2', therapistId: 'ther-2', status: 'PAUSED' });
    const error = await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: 'REASSIGN_PROCESS_CONFLICT', conflicts: 1 });
    expect(memberOf(prisma, WS, 'ther-1').status).toBeUndefined();
    expect(row(prisma, 'clinicalProcess', 'p-active').therapistId).toBe('ther-1');
    expect(row(prisma, 'session', 's-future').therapistId).toBe('ther-1');
    expect(prisma.__store.auditLog).toEqual([]);
    // Un proceso CERRADO del destino con el mismo paciente no impide la reasignación.
    row(prisma, 'clinicalProcess', 'p-dest').status = 'CLOSED';
    await expect(svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' })).resolves.toMatchObject({ reassignment: { processes: 2 } });
  });

  it('la baja toma el lock de la agenda del que se va (y del destino) antes de rechazar sus solicitudes', async () => {
    const prisma = db();
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' });
    const locks: string[] = prisma.__locks;
    expect(locks).toEqual(expect.arrayContaining([`asepsico:member-removal:${WS}`, `schedule:${WS}:ther-1`, `schedule:${WS}:ther-2`]));
    expect(locks.indexOf(`schedule:${WS}:ther-1`)).toBeGreaterThan(locks.indexOf(`asepsico:member-removal:${WS}`));
  });

  it('un ASSISTANT que se va: solo corte de acceso; pedir reasignación → 400', async () => {
    const prisma = db();
    await expect(svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'asst-1', { reassignToUserId: 'ther-2' })).rejects.toMatchObject({ response: { code: 'NOTHING_TO_REASSIGN' } });
    const result = await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'asst-1', { reason: 'END_OF_COLLABORATION' });
    expect(result).toMatchObject({ status: 'REMOVED', reassignment: null });
    expect(memberOf(prisma, WS, 'asst-1').status).toBe('REMOVED');
  });

  it('dar de baja dos veces → 409 MEMBER_ALREADY_REMOVED', async () => {
    const prisma = db();
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'asst-1', {});
    await expect(svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'asst-1', {})).rejects.toMatchObject({ response: { code: 'MEMBER_ALREADY_REMOVED' } });
  });
});

describe('Permisos y último OWNER', () => {
  it('un OWNER no puede darse de baja a sí mismo (ni siendo el último) → 400 sin escribir', async () => {
    const prisma = db();
    await expect(svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'owner-1', {})).rejects.toMatchObject({ response: { code: 'SELF_REMOVAL_NOT_ALLOWED' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(memberOf(prisma, WS, 'owner-1').status).toBeUndefined();
  });

  it('nunca queda un espacio sin OWNER: dos propietarios que se dan de baja mutuamente, el segundo falla', async () => {
    const prisma = db({ workspaceMember: [{ id: 'm-owner2', workspaceId: WS, userId: 'owner-2', role: 'OWNER', isClinician: false, createdAt: new Date('2026-01-09') }] });
    await svc(prisma).remove(WS, actor('owner-2', 'OWNER'), 'owner-1', {});
    await expect(svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'owner-2', {})).rejects.toBeInstanceOf(ForbiddenException);
    const activeOwners = prisma.__store.workspaceMember.filter((m: any) => m.workspaceId === WS && m.role === 'OWNER' && (m.status ?? 'ACTIVE') === 'ACTIVE');
    expect(activeOwners.map((m: any) => m.userId)).toEqual(['owner-2']);
  });

  it('el último OWNER activo no se puede dar de baja aunque el actor sea OWNER según la BD (defensa ante carreras) → 409', async () => {
    // Estado imposible en uso normal (el actor también es OWNER): se fuerza con un count manipulado.
    const prisma = db({ workspaceMember: [{ id: 'm-owner2', workspaceId: WS, userId: 'owner-2', role: 'OWNER', isClinician: false, createdAt: new Date('2026-01-09') }] });
    prisma.workspaceMember.count.mockResolvedValueOnce(1);
    await expect(svc(prisma).remove(WS, actor('owner-2', 'OWNER'), 'owner-1', {})).rejects.toMatchObject({ response: { code: 'LAST_OWNER' } });
    expect(memberOf(prisma, WS, 'owner-1').status).toBeUndefined();
  });

  it.each([
    ['OWNER', 'admin-1'],
    ['ADMIN', 'owner-1'],
  ])('ADMIN no puede dar de baja a un %s → 403 sin escribir', async (_role, target) => {
    const prisma = db();
    await expect(svc(prisma).remove(WS, actor('admin-2', 'ADMIN'), target, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMember.updateMany).not.toHaveBeenCalled();
  });

  it('ADMIN sí da de baja a un THERAPIST', async () => {
    const prisma = db();
    await svc(prisma).remove(WS, actor('admin-1', 'ADMIN'), 'ther-1', { reassignToUserId: 'ther-2' });
    expect(memberOf(prisma, WS, 'ther-1')).toMatchObject({ status: 'REMOVED', removedById: 'admin-1' });
  });

  it.each([['THERAPIST', 'ther-2'], ['ASSISTANT', 'asst-1']])('%s → 403 (baja, vista previa y reasignación)', async (role, sub) => {
    const prisma = db();
    await expect(svc(prisma).remove(WS, actor(sub, role), 'ther-1', {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc(prisma).preview(WS, actor(sub, role), 'ther-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc(prisma).reassignWork(WS, actor(sub, role), 'ther-1', { toUserId: 'ther-2' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMember.updateMany).not.toHaveBeenCalled();
  });

  it('el rol lo decide la BD, no el token: un THERAPIST con token OWNER → 403', async () => {
    const prisma = db();
    await expect(svc(prisma).remove(WS, actor('ther-2', 'OWNER'), 'ther-1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un OWNER ya dado de baja no puede seguir gestionando el equipo', async () => {
    const prisma = db({ workspaceMember: [{ id: 'm-owner2', workspaceId: WS, userId: 'owner-2', role: 'OWNER', isClinician: false, createdAt: new Date('2026-01-09') }] });
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'owner-2', {});
    await expect(svc(prisma).remove(WS, actor('owner-2', 'OWNER'), 'ther-1', {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(new WorkspaceMembersService(prisma).list(WS, actor('owner-2', 'OWNER'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Corte de acceso inmediato del miembro dado de baja', () => {
  const token = { sub: 'ther-1', workspaceId: WS, role: 'THERAPIST', email: 'ther-1@example.test', mfaEnabled: true, sid: 'f-1', tv: 0 };

  it('su access token aún vivo deja de valer en la siguiente petición (401 SESSION_REVOKED)', async () => {
    const prisma = db();
    await expect(assertActiveSession(prisma, token)).resolves.toBeUndefined();
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' });
    await expect(assertActiveSession(prisma, token)).rejects.toMatchObject({ status: 401, response: { code: 'SESSION_REVOKED' } });
  });

  it('también a través de JwtAuthGuard: 401 antes de llegar a cualquier controlador; otro miembro sigue pasando la revalidación', async () => {
    const prisma = db();
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', {});
    jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate').mockResolvedValue(true);
    const ctx = (user: any) => ({ switchToHttp: () => ({ getRequest: () => ({ originalUrl: '/api/v1/patients', user }) }) }) as unknown as ExecutionContext;
    await expect(new JwtAuthGuard(prisma).canActivate(ctx(token))).rejects.toMatchObject({ status: 401 });
    // Control: ther-2 pasa la revalidación de sesión (y se para después en las condiciones: 428).
    await expect(new JwtAuthGuard(prisma).canActivate(ctx({ ...token, sub: 'ther-2', sid: 'f-3' }))).rejects.toMatchObject({ status: 428 });
    jest.restoreAllMocks();
  });

  it('token con tokenVersion antigua o con tv manipulado → 401', async () => {
    const prisma = db();
    prisma.__store.user.find((u: any) => u.id === 'ther-2').tokenVersion = 3;
    const t2 = { sub: 'ther-2', workspaceId: WS };
    await expect(assertActiveSession(prisma, { ...t2, tv: 2 })).rejects.toMatchObject({ status: 401 });
    await expect(assertActiveSession(prisma, t2)).rejects.toMatchObject({ status: 401 });
    await expect(assertActiveSession(prisma, { ...t2, tv: '3' })).rejects.toMatchObject({ status: 401 });
    await expect(assertActiveSession(prisma, { ...t2, tv: 3 })).resolves.toBeUndefined();
  });

  it('no puede iniciar sesión en ese espacio: el login solo usa membresías ACTIVE → 401 genérico', async () => {
    const passwordHash = await hash('contrasena-ficticia-123', 4);
    const memberships = [{ workspaceId: WS, role: 'THERAPIST', status: 'REMOVED', createdAt: new Date('2026-01-01') }];
    const findUnique = jest.fn(async (args: any) => ({
      id: 'ther-1', email: 'ther-1@example.test', passwordHash, firstName: 'Nombre', lastName: 'Ficticio', totpEnabled: false, tokenVersion: 0,
      memberships: memberships.filter((m) => !args.include.memberships.where || m.status === args.include.memberships.where.status),
    }));
    const signAsync = jest.fn(async () => 'token-ficticio');
    const create = jest.fn(async () => ({}));
    const auth = new AuthService({ user: { findUnique }, refreshToken: { create } } as any, { signAsync } as any, {} as any);
    await expect(auth.login({ email: 'ther-1@example.test', password: 'contrasena-ficticia-123' } as any, {})).rejects.toMatchObject({ status: 401 });
    expect(findUnique.mock.calls[0][0].include.memberships.where).toEqual({ status: 'ACTIVE' });
    expect(signAsync).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    // Control: con la membresía activa sí entra.
    memberships[0].status = 'ACTIVE';
    await expect(auth.login({ email: 'ther-1@example.test', password: 'contrasena-ficticia-123' } as any, {})).resolves.toMatchObject({ mfaRequired: false, workspaceId: WS });
  });

  it('no puede renovar la sesión con su refresh token (revocado en la baja)', async () => {
    const prisma = db();
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', {});
    const auth = new AuthService(prisma, { signAsync: jest.fn() } as any, {} as any);
    await expect(auth.refresh('rt-ficticio-ws1', {})).rejects.toMatchObject({ status: 401 });
  });

  it('refresh con una membresía REMOVED aunque el token no estuviera revocado → 401', async () => {
    const prisma = db();
    Object.assign(memberOf(prisma, WS, 'ther-1'), { status: 'REMOVED', removedAt: new Date() });
    const auth = new AuthService(prisma, { signAsync: jest.fn() } as any, {} as any);
    await expect(auth.refresh('rt-ficticio-ws1', {})).rejects.toMatchObject({ status: 401 });
  });
});

describe('GET /workspace-members/:userId/removal-preview y listado', () => {
  it('recuentos y destinos posibles, sin pacientes ni contenido clínico', async () => {
    const prisma = db();
    const preview = await svc(prisma).preview(WS, actor('owner-1', 'OWNER'), 'ther-1');
    expect(preview).toMatchObject({ userId: 'ther-1', role: 'THERAPIST', activeProcesses: 1, pausedProcesses: 1, futureSessions: 1, pendingAppointmentRequests: 1 });
    expect(preview.reassignTargets.map((t: any) => t.userId)).toEqual(['admin-2', 'ther-2']);
    expect(JSON.stringify(preview)).not.toMatch(/pat-|Paciente|Nota/);
  });

  it('el listado del equipo enseña el estado y la fecha de baja', async () => {
    const prisma = db();
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'asst-1', {});
    const rows = await new WorkspaceMembersService(prisma).list(WS, actor('owner-1', 'OWNER'));
    expect(rows.find((r) => r.userId === 'asst-1')).toMatchObject({ status: 'REMOVED', removedAt: expect.any(Date) });
    expect(rows.find((r) => r.userId === 'ther-1')).toMatchObject({ status: 'ACTIVE', removedAt: null });
    expect(rows.some((r) => r.userId === 'owner-x')).toBe(false);
  });

  it('a un miembro dado de baja no se le puede cambiar el atributo clínico (404)', async () => {
    const prisma = db();
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'admin-2', {});
    await expect(new WorkspaceMembersService(prisma).setClinician(WS, actor('owner-1', 'OWNER'), 'admin-2', { isClinician: false })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Qué citas se mueven y qué no lee el destino (condición de Argos)', () => {
  const extraSessions = () => [
    // Cita futura de un proceso CERRADO del que se va: no se mueve.
    { id: 's-closed-future', workspaceId: WS, patientId: 'pat-3', therapistId: 'ther-1', clinicalProcessId: 'p-closed', status: 'SCHEDULED', startsAt: new Date(FUTURE.getTime() + 2 * 3_600_000), endsAt: new Date(FUTURE.getTime() + 3 * 3_600_000) },
    // Cita futura suya enlazada a un proceso de OTRO profesional: no se mueve.
    { id: 's-foreign-process', workspaceId: WS, patientId: 'pat-3', therapistId: 'ther-1', clinicalProcessId: 'p-foreign', status: 'SCHEDULED', startsAt: new Date(FUTURE.getTime() + 4 * 3_600_000), endsAt: new Date(FUTURE.getTime() + 5 * 3_600_000) },
    // Cita futura sin proceso: se mueve.
    { id: 's-noproc', workspaceId: WS, patientId: 'pat-2', clinicalProcessId: null, therapistId: 'ther-1', status: 'SCHEDULED', startsAt: new Date(FUTURE.getTime() + 6 * 3_600_000), endsAt: new Date(FUTURE.getTime() + 7 * 3_600_000) },
    // Cita futura de un proceso reasignado CON resumen interno del que se va: no se mueve ni se vacía.
    { id: 's-private', workspaceId: WS, patientId: 'pat-1', therapistId: 'ther-1', clinicalProcessId: 'p-active', status: 'SCHEDULED', startsAt: new Date(FUTURE.getTime() + 8 * 3_600_000), endsAt: new Date(FUTURE.getTime() + 9 * 3_600_000), internalSummary: encryptField('Resumen interno ficticio de quien se fue') },
  ];
  const setup = () => {
    const prisma = db({ session: extraSessions() });
    prisma.__store.clinicalProcess.push({ id: 'p-foreign', workspaceId: WS, patientId: 'pat-3', therapistId: 'admin-2', status: 'ACTIVE' });
    return prisma;
  };

  it('solo se mueven las citas sin proceso o de un proceso reasignado, y nunca una con resumen interno (se queda, intacta y auditada)', async () => {
    const prisma = setup();
    const result = await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' });
    expect(row(prisma, 'session', 's-future').therapistId).toBe('ther-2');
    expect(row(prisma, 'session', 's-noproc').therapistId).toBe('ther-2');
    expect(row(prisma, 'session', 's-closed-future').therapistId).toBe('ther-1');
    expect(row(prisma, 'session', 's-foreign-process').therapistId).toBe('ther-1');
    expect(row(prisma, 'session', 's-private').therapistId).toBe('ther-1');
    expect(row(prisma, 'session', 's-private').internalSummary).toBeTruthy();
    expect(result.reassignment).toEqual({ toUserId: 'ther-2', processes: 2, futureSessions: 2, keptSessionsWithPrivateNotes: 1 });
    const audit = prisma.__store.auditLog.find((a: any) => a.action === 'MEMBER_WORK_REASSIGNED');
    expect(audit.metadata).toMatchObject({ sessionIds: ['s-future', 's-noproc'], keptSessionIdsWithPrivateNotes: ['s-private'] });
    expect(JSON.stringify(audit)).not.toContain('Resumen interno');
  });

  it('el destino no lee el resumen interno escrito por el que se fue', async () => {
    const prisma = setup();
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' });
    const seen = await new SessionsService(prisma).get(WS, actor('ther-2', 'THERAPIST'), 's-private');
    expect(seen).not.toHaveProperty('internalSummary');
    expect(JSON.stringify(seen)).not.toContain('Resumen interno ficticio');
  });

  it('el destino no pasa a ser autor de los procesos CERRADOS del que se fue con el mismo paciente (sin notas internas, solo lectura)', async () => {
    const prisma = db();
    prisma.__store.clinicalProcess.push({ id: 'p-closed-same', workspaceId: WS, patientId: 'pat-1', therapistId: 'ther-1', status: 'CLOSED', title: 'Proceso ficticio', internalNotes: encryptField('Nota interna ficticia de quien se fue') });
    await svc(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' });
    expect(row(prisma, 'clinicalProcess', 'p-closed-same').therapistId).toBe('ther-1');
    const seen: any = await new ClinicalProcessesService(prisma).get(WS, actor('ther-2', 'THERAPIST'), 'p-closed-same');
    expect(seen).not.toHaveProperty('internalNotes');
    expect(seen.readOnly).toBe(true);
    expect(JSON.stringify(seen)).not.toContain('Nota interna ficticia');
  });
});

describe('Un miembro dado de baja no aparece en los selectores de profesional', () => {
  it('la agenda (selector de profesionales) deja de listarlo', async () => {
    const prisma = fakeClinicalDb({
      workspace: [{ id: WS, timeZone: 'Europe/Madrid' }],
      user: [{ id: 'ther-1', firstName: 'Uno', lastName: 'Ficticio' }, { id: 'ther-2', firstName: 'Dos', lastName: 'Ficticio' }],
      workspaceMember: [
        { id: 'm-owner', workspaceId: WS, userId: 'owner-1', role: 'OWNER', isClinician: false },
        { id: 'm-ther1', workspaceId: WS, userId: 'ther-1', role: 'THERAPIST', isClinician: true, status: 'REMOVED', removedAt: new Date() },
        { id: 'm-ther2', workspaceId: WS, userId: 'ther-2', role: 'THERAPIST', isClinician: true },
      ],
      therapistAvailability: [],
    });
    const { professionals } = await new AvailabilityService(prisma).listProfessionals(actor('owner-1', 'OWNER'));
    expect(professionals.map((p: any) => p.id)).toEqual(['ther-2']);
  });
});

describe('Migración de la baja de miembros', () => {
  const dir = join(__dirname, '..', 'prisma', 'migrations');
  const name = readdirSync(dir).find((d) => d.endsWith('_baja_miembro_y_token_version'));
  const sql = name ? readFileSync(join(dir, name, 'migration.sql'), 'utf8') : '';

  it('añade estado ACTIVE por defecto, tokenVersion 0 y la garantía REMOVED ⇔ removedAt; no borra nada', () => {
    expect(name).toBeDefined();
    expect(sql).toContain(`"status" "WorkspaceMemberStatus" NOT NULL DEFAULT 'ACTIVE'`);
    expect(sql).toContain('"tokenVersion" INTEGER NOT NULL DEFAULT 0');
    expect(sql).toMatch(/CHECK \(\("status" = 'REMOVED'\) = \("removedAt" IS NOT NULL\)\)/);
    expect(sql).not.toMatch(/DELETE|DROP/i);
  });
});
