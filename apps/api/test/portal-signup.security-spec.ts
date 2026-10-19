import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { fakeClinicalDb } from './support/fake-clinical-db';
import { IntakeLinksService } from '../src/portal-signup/intake-links.service';
import { SignupRequestsService } from '../src/portal-signup/signup-requests.service';
import { PortalActivationService } from '../src/portal-signup/portal-activation.service';
import { PortalSignupController, PublicPortalSignupController } from '../src/portal-signup/portal-signup.controller';
import { ActivatePortalAccountDto, SubmitSignupRequestDto } from '../src/portal-signup/dto/portal-signup.dto';
import {
  hashToken, MAX_PENDING_REQUESTS_PER_PROFESSIONAL, MAX_REQUESTS_PER_LINK_PER_HOUR, PORTAL_SIGNUP_NOTICE_VERSIONS, SIGNUP_ACCEPTED_RESPONSE,
} from '../src/portal-signup/portal-signup.config';
import { PortalService } from '../src/portal/portal.service';

/**
 * Alta en el portal con el QR FIJO del profesional (Parte B rediseñada el 18/10/2026):
 * enumeración, menores, spam de solicitudes, vínculo con paciente de otro espacio, token rotado,
 * revisión por rol, cifrado, auditoría sin datos personales y enlace de activación de un solo uso.
 * Base de datos en memoria (support/fake-clinical-db.ts). Datos 100 % ficticios.
 */

const WS = 'ws-1';
const staff = (sub: string, role: string, workspaceId = WS) => ({ sub, role, workspaceId, email: `${sub}@example.com` }) as any;
const owner = staff('owner-1', 'OWNER');
const assistant = staff('assistant-1', 'ASSISTANT');
const therapistA = staff('t-a', 'THERAPIST');
const therapistB = staff('t-b', 'THERAPIST');
const ownerWs2 = staff('owner-2', 'OWNER', 'ws-2');

const ADULT_BIRTH = '1990-04-15';
const yearsAgo = (years: number, extraDays = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
};

function seed(overrides: Record<string, any[]> = {}) {
  return fakeClinicalDb({
    workspace: [{ id: WS }, { id: 'ws-2' }],
    user: [{ id: 't-a', isDemo: false }, { id: 't-b', isDemo: false }, { id: 't-x', isDemo: false }],
    workspaceMember: [
      { workspaceId: WS, userId: 'owner-1', role: 'OWNER', isClinician: false },
      { workspaceId: WS, userId: 'assistant-1', role: 'ASSISTANT', isClinician: false },
      { workspaceId: WS, userId: 't-a', role: 'THERAPIST', isClinician: true },
      { workspaceId: WS, userId: 't-b', role: 'THERAPIST', isClinician: true },
      { workspaceId: 'ws-2', userId: 'owner-2', role: 'OWNER', isClinician: true },
      { workspaceId: 'ws-2', userId: 't-x', role: 'THERAPIST', isClinician: true },
    ],
    patient: [
      { id: 'p1', workspaceId: WS, firstName: 'Lucía', lastName: 'Ficticia Prueba', email: 'Lucia.Ficticia@example.com', phone: '+34 600000000', birthDate: new Date(`${ADULT_BIRTH}T00:00:00Z`), status: 'ACTIVE', portalAccessMode: 'PATIENT_ONLY', deletedAt: null },
      { id: 'p-nobirth', workspaceId: WS, firstName: 'Sin', lastName: 'Fecha', birthDate: null, status: 'ACTIVE', portalAccessMode: 'PATIENT_ONLY', deletedAt: null },
      { id: 'p-minor', workspaceId: WS, firstName: 'Menor', lastName: 'Ficticio', birthDate: new Date(`${yearsAgo(14)}T00:00:00Z`), status: 'ACTIVE', portalAccessMode: 'PATIENT_ONLY', deletedAt: null },
      { id: 'p-blocked', workspaceId: WS, firstName: 'Lucía', lastName: 'Ficticia Prueba', birthDate: new Date(`${ADULT_BIRTH}T00:00:00Z`), status: 'BLOCKED', portalAccessMode: 'PATIENT_ONLY', deletedAt: null },
      { id: 'p-ws2', workspaceId: 'ws-2', firstName: 'Lucía', lastName: 'Ficticia Prueba', birthDate: new Date(`${ADULT_BIRTH}T00:00:00Z`), status: 'ACTIVE', portalAccessMode: 'PATIENT_ONLY', deletedAt: null },
    ],
    clinicalProcess: [
      { id: 'proc-1', workspaceId: WS, patientId: 'p1', therapistId: 't-a', status: 'ACTIVE' },
      { id: 'proc-nb', workspaceId: WS, patientId: 'p-nobirth', therapistId: 't-a', status: 'ACTIVE' },
      { id: 'proc-x', workspaceId: 'ws-2', patientId: 'p-ws2', therapistId: 't-x', status: 'ACTIVE' },
    ],
    patientPortalAccount: [],
    ...overrides,
  } as any);
}

const rows = (prisma: any, model: string) => prisma.__store[model] as any[];
const audits = (prisma: any, action?: string) => rows(prisma, 'auditLog').filter((a) => !action || a.action === action);
const services = (prisma: any) => ({
  links: new IntakeLinksService(prisma),
  requests: new SignupRequestsService(prisma),
  activation: new PortalActivationService(prisma),
});

const body = (token: string, extra: Record<string, unknown> = {}) => ({
  token,
  firstName: 'Lucía',
  lastName: 'Ficticia Prueba',
  email: 'lucia.ficticia@example.com',
  phone: '600 000 000',
  birthDate: ADULT_BIRTH,
  privacyNoticeAcknowledged: true as const,
  portalTermsAccepted: true as const,
  privacyNoticeVersion: PORTAL_SIGNUP_NOTICE_VERSIONS.privacyNotice,
  portalTermsVersion: PORTAL_SIGNUP_NOTICE_VERSIONS.portalTerms,
  ...extra,
});

async function withLink(prisma: any, professional = therapistA) {
  const { token } = await services(prisma).links.rotate(professional.workspaceId, professional, 'me');
  return token;
}

async function pendingRequest(prisma: any, professional = therapistA, extra: Record<string, unknown> = {}) {
  const token = await withLink(prisma, professional);
  await services(prisma).requests.submit(body(token, extra) as any);
  const req = rows(prisma, 'portalSignupRequest').at(-1);
  expect(req).toBeDefined();
  return { token, requestId: req.id as string };
}

const codeOf = (error: any) => error?.getResponse?.()?.code;

// -----------------------------------------------------------------------------------------------
describe('QR fijo del profesional: gestión por rol', () => {
  it('el propio THERAPIST crea su QR; el token solo se guarda como hash y cifrado, nunca en claro ni en la auditoría', async () => {
    const prisma = seed();
    const { token } = await services(prisma).links.rotate(WS, therapistA, 'me');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [link] = rows(prisma, 'portalIntakeLink');
    expect(link.tokenHash).toBe(hashToken(token));
    expect(link.tokenEncrypted).toMatch(/^enc:v\d:/);
    expect(JSON.stringify(rows(prisma, 'portalIntakeLink'))).not.toContain(token);
    expect(JSON.stringify(audits(prisma))).not.toContain(token);
    expect(audits(prisma, 'PORTAL_INTAKE_LINK_CREATED')).toHaveLength(1);
  });

  it('el propio profesional y OWNER/ADMIN pueden volver a ver el token activo (para reimprimirlo)', async () => {
    const prisma = seed();
    const token = await withLink(prisma);
    expect((await services(prisma).links.get(WS, therapistA, 'me')).token).toBe(token);
    expect((await services(prisma).links.get(WS, owner, 't-a')).token).toBe(token);
  });

  it('THERAPIST no gestiona el QR de otro (404); ASSISTANT no gestiona QR (403)', async () => {
    const prisma = seed();
    await expect(services(prisma).links.rotate(WS, therapistB, 't-a')).rejects.toBeInstanceOf(NotFoundException);
    await expect(services(prisma).links.get(WS, therapistB, 't-a')).rejects.toBeInstanceOf(NotFoundException);
    await expect(services(prisma).links.rotate(WS, assistant, 't-a')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(services(prisma).links.rotate(WS, assistant, 'me')).rejects.toBeInstanceOf(ForbiddenException);
    expect(rows(prisma, 'portalIntakeLink')).toHaveLength(0);
  });

  it('profesional de otro espacio o sin perfil clínico → 404', async () => {
    const prisma = seed();
    await expect(services(prisma).links.rotate(WS, owner, 't-x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(services(prisma).links.rotate(WS, owner, 'assistant-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(services(prisma).links.rotate(WS, owner, 'me')).rejects.toBeInstanceOf(NotFoundException); // OWNER no clínico
    expect(rows(prisma, 'portalIntakeLink')).toHaveLength(0);
  });

  it('desactivado: no se vuelve a mostrar el token', async () => {
    const prisma = seed();
    await withLink(prisma);
    await services(prisma).links.disable(WS, owner, 't-a');
    const view = await services(prisma).links.get(WS, therapistA, 'me');
    expect(view).toMatchObject({ isActive: false, token: null });
    expect(audits(prisma, 'PORTAL_INTAKE_LINK_DISABLED')).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------------------------
describe('Envío público: sin enumeración, menores y token rotado', () => {
  it('respuesta IDÉNTICA con token válido, inexistente, rotado y desactivado; solo el válido crea solicitud', async () => {
    const prisma = seed();
    const s = services(prisma);
    const old = await withLink(prisma);
    const current = (await s.links.rotate(WS, owner, 't-a')).token;
    const otherLink = await withLink(prisma, therapistB);
    await s.links.disable(WS, owner, 't-b');

    const responses = [
      await s.requests.submit(body('Z'.repeat(43)) as any),
      await s.requests.submit(body(old) as any),
      await s.requests.submit(body(otherLink) as any),
      await s.requests.submit(body(current) as any),
    ];
    for (const response of responses) expect(response).toEqual(SIGNUP_ACCEPTED_RESPONSE);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
    expect(rows(prisma, 'portalSignupRequest')[0].professionalId).toBe('t-a');
    // La respuesta no nombra a ningún profesional ni a la consulta.
    expect(JSON.stringify(SIGNUP_ACCEPTED_RESPONSE)).not.toMatch(/t-a|ws-1|Ficticia/);
  });

  it('el QR de un profesional que ya no es miembro clínico tampoco crea nada (misma respuesta)', async () => {
    const prisma = seed();
    const token = await withLink(prisma);
    prisma.__store.workspaceMember = rows(prisma, 'workspaceMember').filter((m: any) => m.userId !== 't-a');
    expect(await services(prisma).requests.submit(body(token) as any)).toEqual(SIGNUP_ACCEPTED_RESPONSE);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(0);
  });

  it('menor de 16 → 400 PORTAL_SIGNUP_MIN_AGE con token válido E inválido (no depende del token) y sin guardar nada', async () => {
    const prisma = seed();
    const token = await withLink(prisma);
    for (const t of [token, 'Z'.repeat(43)]) {
      const error = await services(prisma).requests.submit(body(t, { birthDate: yearsAgo(16, 1) }) as any).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(codeOf(error)).toBe('PORTAL_SIGNUP_MIN_AGE');
    }
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(0);
    // Con 16 años cumplidos hoy sí se admite.
    await services(prisma).requests.submit(body(token, { birthDate: yearsAgo(16) }) as any);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
  });

  it('DTO: fecha de nacimiento obligatoria, casillas marcadas, versión vigente y sin campos extra', async () => {
    const check = async (payload: Record<string, unknown>) => validate(plainToInstance(SubmitSignupRequestDto, payload), { whitelist: true, forbidNonWhitelisted: true });
    expect(await check(body('A'.repeat(43)))).toHaveLength(0);
    const { birthDate: _b, ...noBirth } = body('A'.repeat(43));
    expect((await check(noBirth)).map((e) => e.property)).toContain('birthDate');
    expect((await check(body('A'.repeat(43), { privacyNoticeAcknowledged: false }))).map((e) => e.property)).toContain('privacyNoticeAcknowledged');
    expect((await check(body('A'.repeat(43), { portalTermsAccepted: false }))).map((e) => e.property)).toContain('portalTermsAccepted');
    expect((await check(body('A'.repeat(43), { privacyNoticeVersion: 'v-antigua' }))).map((e) => e.property)).toContain('privacyNoticeVersion');
    expect((await check(body('A'.repeat(43), { whatsapp: true }))).map((e) => e.property)).toContain('whatsapp');
    expect((await check(body('A'.repeat(43), { birthDate: '1990-04-15T10:00:00Z' }))).map((e) => e.property)).toContain('birthDate');
  });

  it('la solicitud se guarda cifrada y la auditoría no lleva nombre, email, teléfono, fecha ni token', async () => {
    const prisma = seed();
    const { token } = await pendingRequest(prisma);
    const [req] = rows(prisma, 'portalSignupRequest');
    for (const field of ['firstName', 'lastName', 'email', 'phone', 'birthDate']) expect(req[field]).toMatch(/^enc:v\d:/);
    expect(req.workspaceId).toBe(WS);
    const auditText = JSON.stringify(audits(prisma));
    for (const secret of ['Lucía', 'Ficticia', 'lucia.ficticia@example.com', '600 000 000', ADULT_BIRTH, token]) expect(auditText).not.toContain(secret);
    expect(audits(prisma, 'PORTAL_SIGNUP_REQUEST_CREATED')).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------------------------
describe('Antiabuso: spam de solicitudes', () => {
  it(`más de ${MAX_REQUESTS_PER_LINK_PER_HOUR} por QR y hora → misma respuesta, se descarta y se audita`, async () => {
    const prisma = seed();
    const token = await withLink(prisma);
    for (let i = 0; i < MAX_REQUESTS_PER_LINK_PER_HOUR + 3; i++) {
      expect(await services(prisma).requests.submit(body(token, { email: `spam${i}@example.com` }) as any)).toEqual(SIGNUP_ACCEPTED_RESPONSE);
    }
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(MAX_REQUESTS_PER_LINK_PER_HOUR);
    expect(audits(prisma, 'PORTAL_SIGNUP_REQUEST_DROPPED').map((a) => a.metadata.reason)).toEqual(['LINK_HOURLY_LIMIT', 'LINK_HOURLY_LIMIT', 'LINK_HOURLY_LIMIT']);
    expect(prisma.__locks.every((key: string) => key.startsWith('portal-signup:'))).toBe(true);
  });

  it(`con ${MAX_PENDING_REQUESTS_PER_PROFESSIONAL} pendientes, el profesional no recibe más (misma respuesta)`, async () => {
    const prisma = seed();
    const token = await withLink(prisma);
    const link = rows(prisma, 'portalIntakeLink')[0];
    const future = new Date(Date.now() + 86_400_000);
    prisma.__store.portalSignupRequest = Array.from({ length: MAX_PENDING_REQUESTS_PER_PROFESSIONAL }, (_, i) => ({
      id: `old-${i}`, workspaceId: WS, intakeLinkId: link.id, professionalId: 't-a', expiresAt: future,
    }));
    expect(await services(prisma).requests.submit(body(token) as any)).toEqual(SIGNUP_ACCEPTED_RESPONSE);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(MAX_PENDING_REQUESTS_PER_PROFESSIONAL);
    expect(audits(prisma, 'PORTAL_SIGNUP_REQUEST_DROPPED')[0].metadata.reason).toBe('PENDING_LIMIT');
  });

  it('límite por IP en los dos endpoints públicos (ThrottlerGuard)', () => {
    const proto = PublicPortalSignupController.prototype as any;
    for (const handler of [proto.submit, proto.activate]) {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBeLessThanOrEqual(10);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBeGreaterThanOrEqual(60 * 60_000);
    }
  });

  it('los endpoints de personal llevan JwtAuthGuard; los públicos no exponen nada más', () => {
    const guards = Reflect.getMetadata('__guards__', PortalSignupController) ?? [];
    expect(guards.map((g: any) => g.name)).toContain('JwtAuthGuard');
    expect(Object.getOwnPropertyNames(PublicPortalSignupController.prototype).filter((n) => n !== 'constructor').sort()).toEqual(['activate', 'submit']);
  });
});

// -----------------------------------------------------------------------------------------------
describe('Bandeja: quién ve y resuelve las solicitudes', () => {
  it('THERAPIST ve solo las suyas; OWNER y ASSISTANT todas las del espacio; otro espacio ninguna', async () => {
    const prisma = seed();
    await pendingRequest(prisma, therapistA);
    await pendingRequest(prisma, therapistB, { email: 'otra@example.com' });
    const { requests } = services(prisma);
    expect((await requests.list(WS, therapistA)).map((r: any) => r.professionalId)).toEqual(['t-a']);
    expect((await requests.list(WS, therapistB)).map((r: any) => r.professionalId)).toEqual(['t-b']);
    expect(await requests.list(WS, owner)).toHaveLength(2);
    expect(await requests.list(WS, assistant)).toHaveLength(2);
    expect(await requests.list('ws-2', ownerWs2)).toHaveLength(0);
    // THERAPIST no puede ampliar su alcance con el filtro.
    expect((await requests.list(WS, therapistA, 't-b')).map((r: any) => r.professionalId)).toEqual(['t-a']);
    // Descifrado para quien revisa.
    expect((await requests.list(WS, therapistA))[0]).toMatchObject({ firstName: 'Lucía', email: 'lucia.ficticia@example.com', birthDate: ADULT_BIRTH });
  });

  it('THERAPIST no resuelve solicitudes de otro (404) y otro espacio tampoco (404); la solicitud sigue', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma, therapistA);
    const { requests } = services(prisma);
    await expect(requests.reject(WS, therapistB, requestId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(requests.acceptCreatingPatient(WS, therapistB, requestId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(requests.acceptLinkingPatient('ws-2', ownerWs2, requestId, { patientId: 'p-ws2' })).rejects.toBeInstanceOf(NotFoundException);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
  });

  it('rechazar borra la solicitud y audita sin datos personales', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    await services(prisma).requests.reject(WS, therapistA, requestId);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(0);
    const [audit] = audits(prisma, 'PORTAL_SIGNUP_REQUEST_REJECTED');
    expect(audit).toMatchObject({ workspaceId: WS, actorId: 't-a', entityId: requestId });
    expect(JSON.stringify(audit)).not.toMatch(/Lucía|example\.com/);
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(0);
  });

  it('caducadas (14 días): no se listan, se borran y se audita la caducidad', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    rows(prisma, 'portalSignupRequest')[0].expiresAt = new Date(Date.now() - 1000);
    expect(await services(prisma).requests.list(WS, owner)).toHaveLength(0);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(0);
    expect(audits(prisma, 'PORTAL_SIGNUP_REQUEST_EXPIRED').map((a) => a.entityId)).toEqual([requestId]);
    await expect(services(prisma).requests.reject(WS, owner, requestId)).rejects.toBeInstanceOf(NotFoundException);
  });
});

// -----------------------------------------------------------------------------------------------
describe('Aceptar vinculando a un paciente existente', () => {
  it('paciente de OTRO espacio → 404, sin cuenta y la solicitud sigue pendiente', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    await expect(services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p-ws2' })).rejects.toBeInstanceOf(NotFoundException);
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(0);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
  });

  it('THERAPIST solo vincula a pacientes que trata (404)', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma, therapistB);
    await expect(services(prisma).requests.acceptLinkingPatient(WS, therapistB, requestId, { patientId: 'p1' })).rejects.toBeInstanceOf(NotFoundException);
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(0);
  });

  it.each([
    ['nombre distinto', { firstName: 'Lucia Maria' }],
    ['apellidos distintos', { lastName: 'Otra Persona' }],
    ['fecha distinta', { birthDate: '1990-04-16' }],
  ])('%s → 409 PORTAL_SIGNUP_IDENTITY_MISMATCH, auditado sin datos y nada se crea', async (_label, extra) => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma, therapistA, extra);
    const error = await services(prisma).requests.acceptLinkingPatient(WS, therapistA, requestId, { patientId: 'p1' }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(codeOf(error)).toBe('PORTAL_SIGNUP_IDENTITY_MISMATCH');
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(0);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
    const [audit] = audits(prisma, 'PORTAL_SIGNUP_REQUEST_LINK_REJECTED');
    expect(audit.metadata).toEqual({ patientId: 'p1', reason: 'IDENTITY_MISMATCH' });
  });

  it('tildes, mayúsculas y espacios no impiden la coincidencia', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma, therapistA, { firstName: ' LUCIA ', lastName: 'ficticia  prueba' });
    await expect(services(prisma).requests.acceptLinkingPatient(WS, therapistA, requestId, { patientId: 'p1' })).resolves.toMatchObject({ patientId: 'p1' });
  });

  it('paciente sin fecha de nacimiento o menor de 16 en la ficha → 400 (activación manual con tutor)', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    for (const patientId of ['p-nobirth', 'p-minor']) {
      const error = await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId }).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(codeOf(error)).toBe('PORTAL_SIGNUP_MANUAL_WITH_GUARDIAN');
    }
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(0);
  });

  it('paciente bloqueado → 400; paciente que ya tiene cuenta → 409', async () => {
    const prisma = seed({ patientPortalAccount: [{ id: 'acc-old', workspaceId: WS, patientId: 'p1', accessorType: 'PATIENT', email: 'ya@example.com', isActive: true, pendingActivation: false }] });
    const { requestId } = await pendingRequest(prisma);
    await expect(services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p-blocked' })).rejects.toBeInstanceOf(BadRequestException);
    const error = await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' }).catch((e) => e);
    expect(codeOf(error)).toBe('PORTAL_ACCOUNT_ALREADY_EXISTS');
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(1);
  });

  it('correo ya usado por otra cuenta (otro espacio) → mismo mensaje genérico de hoy y la solicitud NO se consume', async () => {
    const prisma = seed({ patientPortalAccount: [{ id: 'acc-x', workspaceId: 'ws-2', patientId: 'p-ws2', accessorType: 'PATIENT', email: 'lucia.ficticia@example.com', isActive: true }] });
    const { requestId } = await pendingRequest(prisma);
    const error = await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' }).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(String(error.message)).not.toMatch(/otro paciente|workspace|consulta/i);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
    await expect(services(prisma).requests.acceptCreatingPatient(WS, owner, requestId)).rejects.toBeInstanceOf(BadRequestException);
    expect(rows(prisma, 'patient').filter((p: any) => p.workspaceId === WS)).toHaveLength(4);
  });

  it('aceptar: borra la solicitud, crea la cuenta INACTIVA pendiente con el acuse art. 13 y un enlace de activación (solo hash); audita', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    const result = await services(prisma).requests.acceptLinkingPatient(WS, therapistA, requestId, { patientId: 'p1' });
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(0);
    const [account] = rows(prisma, 'patientPortalAccount');
    expect(account).toMatchObject({
      workspaceId: WS, patientId: 'p1', email: 'lucia.ficticia@example.com', accessorType: 'PATIENT', isActive: false, pendingActivation: true, mustChangePassword: false,
      privacyNoticeVersion: PORTAL_SIGNUP_NOTICE_VERSIONS.privacyNotice, portalTermsVersion: PORTAL_SIGNUP_NOTICE_VERSIONS.portalTerms,
    });
    const [activation] = rows(prisma, 'portalActivationToken');
    expect(activation.tokenHash).toBe(hashToken(result.activation.token));
    expect(JSON.stringify(rows(prisma, 'portalActivationToken'))).not.toContain(result.activation.token);
    expect(activation.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(72 * 3_600_000);
    expect(audits(prisma, 'PORTAL_ACCOUNT_ENABLED')[0].metadata).toMatchObject({ patientId: 'p1', origin: 'QR_SIGNUP', professionalId: 't-a' });
    expect(audits(prisma, 'PORTAL_SIGNUP_REQUEST_ACCEPTED')[0].metadata).toMatchObject({ mode: 'LINKED', patientId: 'p1' });
    expect(JSON.stringify(audits(prisma))).not.toContain(result.activation.token);
    // No puede entrar todavía: la cuenta pendiente no inicia sesión.
    await expect(new PortalService(prisma, { signAsync: jest.fn() } as any).login({ email: 'lucia.ficticia@example.com', password: 'Cualquiera1234' })).rejects.toThrow();
  });

  it('dos resoluciones de la misma solicitud: la segunda no encuentra nada (404)', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' });
    await expect(services(prisma).requests.acceptCreatingPatient(WS, assistant, requestId)).rejects.toBeInstanceOf(NotFoundException);
    expect(rows(prisma, 'patientPortalAccount')).toHaveLength(1);
  });
});

describe('Aceptar creando un paciente nuevo', () => {
  it('ASSISTANT puede (P7); el paciente nace con los datos de la solicitud, PATIENT_ONLY, y se audita con origen QR', async () => {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    const result = await services(prisma).requests.acceptCreatingPatient(WS, assistant, requestId);
    const patient = rows(prisma, 'patient').find((p: any) => p.id === result.patientId);
    expect(patient).toMatchObject({ workspaceId: WS, firstName: 'Lucía', lastName: 'Ficticia Prueba', email: 'lucia.ficticia@example.com', portalAccessMode: 'PATIENT_ONLY' });
    expect(patient.birthDate.toISOString().slice(0, 10)).toBe(ADULT_BIRTH);
    expect(audits(prisma, 'PATIENT_CREATED')[0].metadata).toMatchObject({ origin: 'QR_SIGNUP' });
    expect(rows(prisma, 'patientPortalAccount')[0]).toMatchObject({ patientId: result.patientId, pendingActivation: true, isActive: false });
  });
});

// -----------------------------------------------------------------------------------------------
describe('Enlace de activación: un solo uso, caducidad, revocación', () => {
  async function accepted() {
    const prisma = seed();
    const { requestId } = await pendingRequest(prisma);
    const result = await services(prisma).requests.acceptLinkingPatient(WS, owner, requestId, { patientId: 'p1' });
    return { prisma, token: result.activation.token };
  }
  const PASSWORD = 'NuevaClave2026x';
  const invalidCode = async (promise: Promise<unknown>) => codeOf(await promise.catch((e) => e));

  it('canje correcto: cuenta activa con la contraseña elegida, mustChangePassword=false, auditado sin token', async () => {
    const { prisma, token } = await accepted();
    await expect(services(prisma).activation.redeem({ token, password: PASSWORD })).resolves.toEqual({ ok: true });
    const [account] = rows(prisma, 'patientPortalAccount');
    expect(account).toMatchObject({ isActive: true, pendingActivation: false, mustChangePassword: false });
    expect(await bcrypt.compare(PASSWORD, account.passwordHash)).toBe(true);
    expect(rows(prisma, 'portalActivationToken')[0].usedAt).toBeInstanceOf(Date);
    expect(audits(prisma, 'PORTAL_ACCOUNT_ACTIVATED')).toHaveLength(1);
    expect(JSON.stringify(audits(prisma))).not.toContain(token);
  });

  it('reutilizado, caducado, inexistente y anterior a un reenvío → el mismo 400 genérico', async () => {
    const { prisma, token } = await accepted();
    expect(await invalidCode(services(prisma).activation.redeem({ token: 'Q'.repeat(43), password: PASSWORD }))).toBe('PORTAL_ACTIVATION_INVALID');

    rows(prisma, 'portalActivationToken')[0].expiresAt = new Date(Date.now() - 1000);
    expect(await invalidCode(services(prisma).activation.redeem({ token, password: PASSWORD }))).toBe('PORTAL_ACTIVATION_INVALID');

    const reissued = await services(prisma).activation.reissue(WS, therapistA, 'p1');
    rows(prisma, 'portalActivationToken')[0].expiresAt = new Date(Date.now() + 3_600_000); // aunque no hubiera caducado: revocado
    expect(await invalidCode(services(prisma).activation.redeem({ token, password: PASSWORD }))).toBe('PORTAL_ACTIVATION_INVALID');

    await services(prisma).activation.redeem({ token: reissued.activation.token, password: PASSWORD });
    expect(await invalidCode(services(prisma).activation.redeem({ token: reissued.activation.token, password: 'OtraClave2026xx' }))).toBe('PORTAL_ACTIVATION_INVALID');
    expect(await bcrypt.compare(PASSWORD, rows(prisma, 'patientPortalAccount')[0].passwordHash)).toBe(true);
  });

  it('desactivar el portal o bloquear al paciente invalida el enlace', async () => {
    const first = await accepted();
    await new PortalService(first.prisma, {} as any).disable(WS, owner, 'p1');
    expect(await invalidCode(services(first.prisma).activation.redeem({ token: first.token, password: PASSWORD }))).toBe('PORTAL_ACTIVATION_INVALID');

    const second = await accepted();
    rows(second.prisma, 'patient').find((p: any) => p.id === 'p1').status = 'BLOCKED';
    expect(await invalidCode(services(second.prisma).activation.redeem({ token: second.token, password: PASSWORD }))).toBe('PORTAL_ACTIVATION_INVALID');
    expect(rows(second.prisma, 'patientPortalAccount')[0].isActive).toBe(false);
    expect(rows(second.prisma, 'portalActivationToken')[0].usedAt ?? null).toBeNull();
  });

  it('reenviar el enlace: THERAPIST solo de pacientes que trata; otro espacio 404', async () => {
    const { prisma } = await accepted();
    await expect(services(prisma).activation.reissue(WS, therapistB, 'p1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(services(prisma).activation.reissue('ws-2', ownerWs2, 'p1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(services(prisma).activation.reissue(WS, assistant, 'p1')).resolves.toMatchObject({ activation: { token: expect.any(String) } });
  });

  it('DTO de activación: misma política de contraseña que el cambio de contraseña', async () => {
    const check = async (password: string) => validate(plainToInstance(ActivatePortalAccountDto, { token: 'A'.repeat(43), password }));
    expect(await check('corta1A')).not.toHaveLength(0);
    expect(await check('sinmayusculas123')).not.toHaveLength(0);
    expect(await check('ClaveValida2026')).toHaveLength(0);
  });
});
