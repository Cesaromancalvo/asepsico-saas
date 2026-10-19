import 'reflect-metadata';
import { ConflictException, ForbiddenException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { waitlistBodyParser } from '../src/waitlist/waitlist-body.middleware';
import { PORTAL_SIGNUP_PUBLIC_PATH, SIGNUP_ACCEPTED_RESPONSE } from '../src/portal-signup/portal-signup.config';
import { PortalAccountEmailService } from '../src/portal-signup/portal-account-email.service';
import { PublicPortalSignupController } from '../src/portal-signup/portal-signup.controller';
import { SignupRequestsService } from '../src/portal-signup/signup-requests.service';
import { PortalActivationService } from '../src/portal-signup/portal-activation.service';
import { portalEmailUsableForDelivery } from '../src/portal/portal-email.util';
import { PatientsService } from '../src/patients/patients.service';
import { PortalService } from '../src/portal/portal.service';
import {
  WS, assistant, audits, body, codeOf, owner, ownerWs2, pendingRequest, rows, seed, services, therapistA, therapistB, withLink,
} from './support/portal-signup-fixture';

/**
 * Condiciones de Argos (19/10/2026) sobre el alta por QR fijo del profesional: suplantación al
 * vincular, entrega del enlace solo en persona, correo sin verificar, proceso del THERAPIST que
 * crea al paciente, rechazo masivo, revocación al archivar/restaurar y límite de cuerpo.
 * Datos 100 % ficticios.
 */

describe('Argos 1: suplantación al vincular', () => {
  it('correo distinto al de la ficha → 409 con aviso; confirmado → acepta y audita la confirmación', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma, therapistA, { email: 'otra.direccion@example.com' });
    const error = await services(prisma).requests.acceptLinkingPatient(WS, therapistA, requestId, { patientId: 'p1' }).catch((e) => e);
    expect(codeOf(error)).toBe('PORTAL_SIGNUP_CONFIRMATION_REQUIRED');
    expect(error.getResponse().warnings).toEqual(['EMAIL_MISMATCH']);
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(0);
    expect(audits(prisma, 'PORTAL_SIGNUP_REQUEST_LINK_REJECTED')[0].metadata).toMatchObject({ reason: 'CONFIRMATION_REQUIRED', warnings: ['EMAIL_MISMATCH'] });

    await services(prisma).requests.acceptLinkingPatient(WS, therapistA, requestId, { patientId: 'p1', confirmWarnings: ['EMAIL_MISMATCH'] });
    expect(audits(prisma, 'PORTAL_SIGNUP_WARNINGS_CONFIRMED')[0]).toMatchObject({ actorId: 't-a', metadata: { patientId: 'p1', warnings: ['EMAIL_MISMATCH'], previousAccountId: null } });
    expect(JSON.stringify(audits(prisma))).not.toContain('otra.direccion@example.com');
  });

  it('teléfono distinto → PHONE_MISMATCH; el mismo número escrito de otra forma no avisa', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma, therapistA, { phone: '611 111 111' });
    const error = await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' }).catch((e) => e);
    expect(error.getResponse().warnings).toEqual(['PHONE_MISMATCH']);
    const other = seed();
    const second = await pendingRequest(other, therapistA, { phone: '600000000' });
    await expect(services(other).requests.acceptLinkingPatient(WS, owner, second.requestId, { patientId: 'p1' })).resolves.toMatchObject({ patientId: 'p1' });
  });

  it('paciente con el portal DESACTIVADO antes → 409 PORTAL_PREVIOUSLY_DISABLED; confirmado crea otra cuenta y audita la anterior', async () => {
    const prisma = seed({ patientPortalAccount: [{ id: 'acc-old', workspaceId: WS, patientId: 'p1', accessorType: 'PATIENT', email: 'antigua@example.com', isActive: false, pendingActivation: false }] });
    const { requestId } = await pendingRequest(prisma);
    const error = await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().warnings).toEqual(['PORTAL_PREVIOUSLY_DISABLED']);
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(1);

    await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1', confirmWarnings: ['PORTAL_PREVIOUSLY_DISABLED'] });
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(2);
    expect(rows(prisma, 'patientPortalAccount').find((a: any) => a.id === 'acc-old').isActive).toBe(false);
    expect(audits(prisma, 'PORTAL_SIGNUP_WARNINGS_CONFIRMED')[0].metadata).toMatchObject({ warnings: ['PORTAL_PREVIOUSLY_DISABLED'], previousAccountId: 'acc-old' });
  });

  it('el enlace de activación se entrega solo en persona: delivery IN_PERSON_ONLY y ninguna notificación', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    const accepted = await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' });
    expect(accepted.activation.delivery).toBe('IN_PERSON_ONLY');
    const reissued = await services(prisma).activation.reissue(WS, owner, 'p1');
    expect(reissued.activation.delivery).toBe('IN_PERSON_ONLY');
    expect(rows(prisma, 'notification')).toHaveLength(0);
    expect(rows(prisma, 'notificationDelivery')).toHaveLength(0);
  });
});

describe('Argos 2: correo sin verificar', () => {
  it('las cuentas nacen sin verificar y ese correo no sirve para entregas', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    const { token } = (await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' })).activation;
    await services(prisma).activation.redeem({ token, password: 'ClaveValida2026' });
    const [account] = rows(prisma, 'patientPortalAccount');
    expect(account.emailVerifiedAt ?? null).toBeNull();
    expect(portalEmailUsableForDelivery(account)).toBe(false);
    expect(portalEmailUsableForDelivery({ ...account, emailVerifiedAt: new Date() })).toBe(true);
    expect(portalEmailUsableForDelivery({ ...account, isActive: false, emailVerifiedAt: new Date() })).toBe(false);
  });

  it('liberar un correo ocupado por error: solo OWNER/ADMIN, cuenta desactivada y sin verificar; auditado sin el correo', async () => {
    const prisma = seed({ patientPortalAccount: [
      { id: 'acc-on', workspaceId: WS, patientId: 'p1', email: 'ocupado@example.com', isActive: true, pendingActivation: false, emailVerifiedAt: null },
      { id: 'acc-off', workspaceId: WS, patientId: 'p1', email: 'error@example.com', isActive: false, pendingActivation: false, emailVerifiedAt: null },
      { id: 'acc-ok', workspaceId: WS, patientId: 'p1', email: 'verificado@example.com', isActive: false, pendingActivation: false, emailVerifiedAt: new Date() },
      { id: 'acc-ws2', workspaceId: 'ws-2', patientId: 'p-ws2', email: 'ajeno@example.com', isActive: false, pendingActivation: false, emailVerifiedAt: null },
    ] });
    const svc = new PortalAccountEmailService(prisma);
    await expect(svc.release(WS, therapistA, 'p1', 'acc-off')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.release(WS, assistant, 'p1', 'acc-off')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.release(WS, owner, 'p1', 'acc-on')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.release(WS, owner, 'p1', 'acc-ok')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.release(WS, owner, 'p-ws2', 'acc-ws2')).rejects.toBeInstanceOf(NotFoundException);
    await svc.release(WS, owner, 'p1', 'acc-off');
    expect(rows(prisma, 'patientPortalAccount').map((a: any) => a.email)).toEqual(['ocupado@example.com', 'liberado-acc-off@liberado.invalid', 'verificado@example.com', 'ajeno@example.com']);
    const [audit] = audits(prisma, 'PORTAL_ACCOUNT_EMAIL_RELEASED');
    expect(audit).toMatchObject({ workspaceId: WS, entityId: 'acc-off', metadata: { patientId: 'p1' } });
    expect(JSON.stringify(audit)).not.toContain('error@example.com');
  });
});

describe('Argos 3: THERAPIST crea el paciente desde la bandeja', () => {
  it('se crea su proceso ACTIVO en la misma transacción y puede volver a emitir el enlace', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma, therapistA);
    const result = await services(prisma).requests.acceptCreatingPatient(WS, therapistA, requestId);
    const processes = rows(prisma, 'clinicalProcess').filter((p: any) => p.patientId === result.patientId);
    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({ workspaceId: WS, therapistId: 't-a' });
    // Estado: el valor por defecto del esquema (ACTIVE); el doble no aplica defaults, así que no
    // debe venir otro estado escrito. Con PostgreSQL real lo comprueba portal-signup-race.
    expect(processes[0].status ?? 'ACTIVE').toBe('ACTIVE');
    expect(processes[0].consultationReason ?? null).toBeNull();
    expect(audits(prisma, 'CLINICAL_PROCESS_CREATED')[0].metadata).toMatchObject({ patientId: result.patientId, therapistId: 't-a', origin: 'QR_SIGNUP' });
    const reissued = await services(prisma).activation.reissue(WS, therapistA, result.patientId);
    expect(reissued.activation.token).not.toBe(result.activation.token);
    await expect(services(prisma).activation.reissue(WS, therapistB, result.patientId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('si lo crea ASSISTANT no se abre proceso (no es su terapeuta)', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma, therapistA);
    const result = await services(prisma).requests.acceptCreatingPatient(WS, assistant, requestId);
    expect(rows(prisma, 'clinicalProcess').filter((p: any) => p.patientId === result.patientId)).toHaveLength(0);
  });

  it('si falla la auditoría no queda paciente, proceso ni cuenta, y la solicitud sigue', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma, therapistA);
    const patientsBefore = rows(prisma, 'patient').length;
    const processesBefore = rows(prisma, 'clinicalProcess').length;
    const original = prisma.auditLog.create;
    prisma.auditLog.create = jest.fn(async (args: any) => {
      if (args.data.action === 'PORTAL_SIGNUP_REQUEST_ACCEPTED') throw new Error('auditoría caída');
      return original(args);
    });
    await expect(services(prisma).requests.acceptCreatingPatient(WS, therapistA, requestId)).rejects.toThrow('auditoría caída');
    expect(rows(prisma, 'patient')).toHaveLength(patientsBefore);
    expect(rows(prisma, 'clinicalProcess')).toHaveLength(processesBefore);
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(0);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
  });
});

describe('Argos 4: rechazo masivo', () => {
  it('rechaza en una transacción con una auditoría de recuentos; THERAPIST solo las suyas', async () => {
    const prisma = seed();
    const token = await withLink(prisma, therapistA);
    for (let i = 0; i < 5; i++) await services(prisma).requests.submit(body(token, { email: `spam${i}@example.com` }) as any);
    await pendingRequest(prisma, therapistB, { email: 'de-b@example.com' });
    const idsA = rows(prisma, 'portalSignupRequest').filter((r: any) => r.professionalId === 't-a').map((r: any) => r.id);
    const idB = rows(prisma, 'portalSignupRequest').find((r: any) => r.professionalId === 't-b').id;

    const result = await services(prisma).requests.rejectMany(WS, therapistA, { requestIds: [...idsA, idB, 'no-existe'] });
    expect(result).toEqual({ rejected: 5, notFound: 2 });
    expect(rows(prisma, 'portalSignupRequest').map((r: any) => r.id)).toEqual([idB]);
    const [audit] = audits(prisma, 'PORTAL_SIGNUP_REQUESTS_BULK_REJECTED');
    expect(audit).toMatchObject({ workspaceId: WS, actorId: 't-a', metadata: { requested: 7, rejected: 5, notFound: 2 } });
    expect([...audit.metadata.requestIds].sort()).toEqual([...idsA].sort());
    expect(JSON.stringify(audit)).not.toMatch(/example\.com|Lucía/);
  });

  it('otro espacio no rechaza nada', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    expect(await services(prisma).requests.rejectMany('ws-2', ownerWs2, { requestIds: [requestId] })).toEqual({ rejected: 0, notFound: 1 });
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
  });
});

describe('Argos: el enlace de activación queda revocado al archivar y restaurar', () => {
  it('archivar revoca; restaurar no lo resucita (400 genérico)', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    const { token } = (await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' })).activation;
    const patients = new PatientsService(prisma);
    await patients.archive(WS, owner, 'p1');
    expect(rows(prisma, 'portalActivationToken')[0].revokedAt).toBeInstanceOf(Date);
    await patients.restore(WS, owner, 'p1');
    const error = await services(prisma).activation.redeem({ token, password: 'ClaveValida2026' }).catch((e) => e);
    expect(codeOf(error)).toBe('PORTAL_ACTIVATION_INVALID');
    expect(rows(prisma, 'patientPortalAccount')[0].isActive).toBe(false);
  });
});

describe('Argos M1: activación manual con otro correo sobre una cuenta QR pendiente', () => {
  it('la cuenta pendiente queda inactiva, su enlace devuelve 400 y solo hay una cuenta PATIENT activa o pendiente', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    const { token } = (await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' })).activation;

    await new PortalService(prisma, {} as any).enable(WS, owner, 'p1', { email: 'manual.distinto@example.com', temporaryPassword: 'Temporal12345A' } as any);

    const error = await services(prisma).activation.redeem({ token, password: 'ClaveValida2026' }).catch((e) => e);
    expect(codeOf(error)).toBe('PORTAL_ACTIVATION_INVALID');
    const live = rows(prisma, 'patientPortalAccount').filter((a: any) => a.patientId === 'p1' && a.accessorType === 'PATIENT' && (a.isActive || a.pendingActivation));
    expect(live.map((a: any) => a.email)).toEqual(['manual.distinto@example.com']);
    expect(rows(prisma, 'portalActivationToken').every((t: any) => t.revokedAt instanceof Date)).toBe(true);
    const [audit] = audits(prisma, 'PORTAL_PENDING_ACTIVATION_SUPERSEDED');
    expect(audit).toMatchObject({ workspaceId: WS, actorId: 'owner-1', entityId: 'p1', metadata: { patientId: 'p1', supersededAccounts: 1 } });
    expect(JSON.stringify(audit)).not.toContain('example.com');
  });

  it('activar a mano el MISMO correo de la cuenta pendiente la reutiliza (activa, ya no pendiente, enlace revocado)', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    const { token } = (await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' })).activation;
    await new PortalService(prisma, {} as any).enable(WS, owner, 'p1', { email: 'lucia.ficticia@example.com', temporaryPassword: 'Temporal12345A' } as any);
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(1);
    expect(rows(prisma, 'patientPortalAccount')[0]).toMatchObject({ isActive: true, pendingActivation: false, mustChangePassword: true });
    expect(codeOf(await services(prisma).activation.redeem({ token, password: 'ClaveValida2026' }).catch((e) => e))).toBe('PORTAL_ACTIVATION_INVALID');
  });
});

describe('Argos: cuerpo de las rutas públicas', () => {
  let app: INestApplication;
  const submit = jest.fn(async () => SIGNUP_ACCEPTED_RESPONSE);
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicPortalSignupController],
      providers: [{ provide: SignupRequestsService, useValue: { submit } }, { provide: PortalActivationService, useValue: { redeem: jest.fn() } }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(PORTAL_SIGNUP_PUBLIC_PATH, waitlistBodyParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it('más de 16 KB → 413 sin llegar al servicio; no JSON → 415', async () => {
    const big = body('A'.repeat(43), { firstName: 'x'.repeat(17 * 1024) });
    const res = await request(app.getHttpServer()).post(`${PORTAL_SIGNUP_PUBLIC_PATH}/requests`).send(big).expect(413);
    expect(res.body).toEqual({ statusCode: 413, message: 'Payload Too Large' });
    await request(app.getHttpServer()).post(`${PORTAL_SIGNUP_PUBLIC_PATH}/activate`).type('form').send('token=x').expect(415);
    expect(submit).not.toHaveBeenCalled();
  });

  it('un cuerpo válido pasa con no-store y no-referrer', async () => {
    const res = await request(app.getHttpServer()).post(`${PORTAL_SIGNUP_PUBLIC_PATH}/requests`).send(body('A'.repeat(43))).expect(202);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
