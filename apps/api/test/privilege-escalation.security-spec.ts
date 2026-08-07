import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PatientsService } from '../src/patients/patients.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { getJwtSecret } from '../src/auth/jwt-secret.util';
import { getPortalJwtSecret } from '../src/portal/portal-jwt-secret.util';

/**
 * Regresión para el hallazgo: un paciente con acceso al portal podía reutilizar su propio
 * `portal_access_token` como header `Authorization: Bearer` contra endpoints de staff
 * (GET /patients, GET /sessions). El payload de un token de portal no tiene `role` (tiene
 * `kind: 'patient_portal'`), y el código de negocio escribía "restringe solo si el rol es
 * THERAPIST", así que cualquier otro valor de `role` (incluido `undefined`) pasaba sin
 * restricción, como si fuera OWNER/ADMIN.
 *
 * Estos tests fijan las dos capas de la solución:
 * 1) El JwtStrategy de staff rechaza por forma cualquier payload que no sea de staff.
 * 2) Los servicios de negocio fallan cerrado (ForbiddenException) ante un rol desconocido,
 *    en vez de conceder acceso por omisión.
 */

const portalLikePayload = {
  kind: 'patient_portal',
  portalAccountId: 'portal-account-1',
  patientId: 'patient-1',
  workspaceId: 'ws-1',
};

const unknownRoleActor = { sub: 'someone-1', workspaceId: 'ws-1', role: undefined, email: 'x@example.com' } as any;

function patientsPrismaMock() {
  return {
    patient: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    session: { findMany: jest.fn() },
    clinicalProcess: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  } as any;
}

function sessionsPrismaMock() {
  return {
    session: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  } as any;
}

describe('Cross-domain token confusion (portal token reused as staff token)', () => {
  it('el JwtStrategy de staff rechaza un payload con forma de token de portal', () => {
    const strategy = new JwtStrategy();
    expect(() => strategy.validate(portalLikePayload)).toThrow(UnauthorizedException);
  });

  it('el JwtStrategy de staff rechaza un payload sin role/sub/workspaceId', () => {
    const strategy = new JwtStrategy();
    expect(() => strategy.validate({})).toThrow(UnauthorizedException);
    expect(() => strategy.validate({ sub: 'x', workspaceId: 'ws-1' })).toThrow(UnauthorizedException);
  });

  it('el JwtStrategy de staff acepta un payload de staff genuino', () => {
    const strategy = new JwtStrategy();
    const staffPayload = { sub: 'user-1', workspaceId: 'ws-1', role: 'THERAPIST', email: 'a@example.com' };
    expect(strategy.validate(staffPayload)).toEqual(staffPayload);
  });

  it('el secreto del portal es distinto al de staff incluso con los valores de desarrollo por defecto', () => {
    expect(getPortalJwtSecret()).not.toEqual(getJwtSecret());
  });
});

describe('PatientsService falla cerrado ante un rol desconocido', () => {
  it('list() rechaza en vez de devolver el listado completo sin restricción', async () => {
    const prisma = patientsPrismaMock();
    const service = new PatientsService(prisma);
    await expect(service.list('ws-1', unknownRoleActor, {} as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
  });

  it('get() rechaza en vez de devolver la ficha del paciente', async () => {
    const prisma = patientsPrismaMock();
    const service = new PatientsService(prisma);
    await expect(service.get('ws-1', unknownRoleActor, 'patient-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });

  it('create() rechaza en vez de dar de alta un paciente', async () => {
    const prisma = patientsPrismaMock();
    const service = new PatientsService(prisma);
    await expect(service.create('ws-1', unknownRoleActor, {
      firstName: 'X', lastName: 'Y',
    } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('SessionsService falla cerrado ante un rol desconocido', () => {
  it('list() rechaza en vez de devolver las sesiones de todo el workspace', async () => {
    const prisma = sessionsPrismaMock();
    const service = new SessionsService(prisma);
    await expect(service.list('ws-1', unknownRoleActor, {} as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.session.findMany).not.toHaveBeenCalled();
  });

  it('get() rechaza en vez de devolver el detalle de una sesión ajena', async () => {
    const prisma = sessionsPrismaMock();
    const service = new SessionsService(prisma);
    await expect(service.get('ws-1', unknownRoleActor, 'session-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
  });

  it('get() bloquea a un THERAPIST que intenta ver la sesión de otro profesional', async () => {
    const prisma = sessionsPrismaMock();
    prisma.session.findFirst.mockResolvedValue({ id: 'session-1', therapistId: 'other-therapist' });
    const service = new SessionsService(prisma);
    const therapist = { sub: 'therapist-1', workspaceId: 'ws-1', role: 'THERAPIST', email: 't@example.com' } as any;
    await expect(service.get('ws-1', therapist, 'session-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('get() ya no expone consultationReason/goals del proceso clínico', async () => {
    const prisma = sessionsPrismaMock();
    prisma.session.findFirst.mockResolvedValue({ id: 'session-1', therapistId: 'therapist-1' });
    const service = new SessionsService(prisma);
    const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER', email: 'o@example.com' } as any;
    await service.get('ws-1', owner, 'session-1');
    const args = prisma.session.findFirst.mock.calls[0][0];
    expect(args.include.clinicalProcess.select).not.toHaveProperty('consultationReason');
    expect(args.include.clinicalProcess.select).not.toHaveProperty('goals');
  });
});
