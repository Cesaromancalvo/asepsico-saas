import { BadRequestException, ExecutionContext, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RegistrationService, REGISTRATION_NOT_ALLOWED } from '../src/auth/registration.service';
import { AuthController } from '../src/auth/auth.controller';
import { RegisterDto, RegisterMemberDto } from '../src/auth/dto/register.dto';
import { hashInviteToken, INVITE_TTL_MS } from '../src/auth/invite-token.util';
import * as legalDocs from '../src/legal/legal-documents';
import { assertTermsAccepted, LEGAL_TERMS_DRAFT, TERMS_ACCEPTANCE_REQUIRED, TERMS_NOT_ACCEPTED } from '../src/legal/terms-acceptance';
import { EnvironmentController, isDemoEnvironment } from '../src/health/environment.controller';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../src/auth/auth.service';
import { LegalService } from '../src/legal/legal.service';
import { LegalController } from '../src/legal/legal.controller';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { WorkspaceInvitesService } from '../src/workspace-members/workspace-invites.service';
import { WorkspaceMembersController } from '../src/workspace-members/workspace-members.controller';
import { CreateMemberInviteDto } from '../src/workspace-members/dto/create-member-invite.dto';
import { fakeRegistrationDb } from './support/fake-registration-db';

/**
 * Registro cerrado por invitación, aceptación versionada de condiciones e invitación de miembros.
 * Datos 100 % ficticios.
 */

const DAY = 24 * 60 * 60 * 1000;
const TOKEN = 'token-ficticio-de-invitacion-0123456789abcdefghijk';
const EMAIL = 'titular@example.com';
const currentTerms = () => legalDocs.getCurrentLegalDocuments().map((d) => ({ documentType: d.type, version: d.version, textHash: d.textHash }));
const validDto = (extra: Record<string, unknown> = {}) => ({
  firstName: 'Titular', lastName: 'Ficticio', email: EMAIL, password: 'contrasena-ficticia-larga',
  workspaceName: 'Consulta ficticia', inviteToken: TOKEN, acceptedTerms: currentTerms(), ...extra,
}) as any;
const invite = (extra: Record<string, unknown> = {}) => ({
  id: 'inv-1', tokenHash: hashInviteToken(TOKEN), email: EMAIL, expiresAt: new Date(Date.now() + 14 * DAY),
  createdBy: 'cli', createdAt: new Date(), usedAt: null, revokedAt: null, usedByUserId: null, workspaceId: null, ...extra,
});
const META = { ip: '203.0.113.7', userAgent: 'jest' };

function registration(prisma: any) {
  const auth: any = { issueSession: jest.fn(async (user: any, workspaceId: string, role: string) => ({ user: { id: user.id }, workspaceId, role })) };
  return { service: new RegistrationService(prisma, auth), auth };
}

async function expectNeutral(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  expect(error.getResponse()).toEqual({
    statusCode: 400, code: REGISTRATION_NOT_ALLOWED,
    message: 'No se ha podido completar el registro. Revisa el enlace de invitación o pide uno nuevo.',
  });
}

function expectNothingCreated(prisma: any) {
  expect(prisma.__store.user).toEqual([]);
  expect(prisma.__store.workspace).toEqual([]);
  expect(prisma.__store.workspaceMember).toEqual([]);
  expect(prisma.__store.termsAcceptance).toEqual([]);
  expect(prisma.__store.auditLog).toEqual([]);
}

afterEach(() => jest.restoreAllMocks());

describe('POST /auth/register: registro solo por invitación', () => {
  it('sin invitación → 400 neutro y no crea nada', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    await expectNeutral(registration(prisma).service.register(validDto({ inviteToken: undefined }), META));
    expectNothingCreated(prisma);
  });

  it('token inventado → la MISMA respuesta neutra', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    await expectNeutral(registration(prisma).service.register(validDto({ inviteToken: 'otro-token-que-no-existe-en-la-base-de-datos' }), META));
    expectNothingCreated(prisma);
  });

  it('token caducado → neutro y la invitación sigue sin usar', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite({ expiresAt: new Date(Date.now() - 1000) })] });
    await expectNeutral(registration(prisma).service.register(validDto(), META));
    expectNothingCreated(prisma);
    expect(prisma.__store.registrationInvite[0].usedAt).toBeNull();
  });

  it('token revocado → neutro', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite({ revokedAt: new Date() })] });
    await expectNeutral(registration(prisma).service.register(validDto(), META));
    expectNothingCreated(prisma);
  });

  it('token de un solo uso: el segundo registro con el mismo token → neutro', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    const { service } = registration(prisma);
    await service.register(validDto(), META);
    await expectNeutral(service.register(validDto(), META));
    await expectNeutral(service.register(validDto({ email: 'otra@example.com' }), META));
    expect(prisma.__store.user).toHaveLength(1);
    expect(prisma.__store.workspace).toHaveLength(1);
  });

  it('consumo atómico: si otra petición gana la carrera, rollback completo (sin usuario ni workspace)', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    // La invitación se lee válida, pero alguien la consume antes del compare-and-set.
    prisma.registrationInvite.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    await expectNeutral(registration(prisma).service.register(validDto(), META));
    expectNothingCreated(prisma);
  });

  it('token emitido a otro correo → neutro y la invitación no se consume', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    await expectNeutral(registration(prisma).service.register(validDto({ email: 'intruso@example.com' }), META));
    expectNothingCreated(prisma);
    expect(prisma.__store.registrationInvite[0].usedAt).toBeNull();
  });

  it('correo ya registrado → neutro (no revela cuentas existentes)', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()], user: [{ id: 'u-x', email: EMAIL }] });
    await expectNeutral(registration(prisma).service.register(validDto(), META));
    expect(prisma.__store.registrationInvite[0].usedAt).toBeNull();
  });

  it('el correo se compara normalizado (mayúsculas y espacios)', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    await registration(prisma).service.register(validDto({ email: '  Titular@Example.COM ' }), META);
    expect(prisma.__store.user[0].email).toBe(EMAIL);
  });

  it.each([
    ['sin acceptedTerms', undefined],
    ['lista vacía', []],
    ['falta un documento', () => currentTerms().slice(1)],
    ['versión antigua', () => currentTerms().map((t, i) => (i === 0 ? { ...t, version: '0.0-antigua' } : t))],
    ['hash de otro texto', () => currentTerms().map((t, i) => (i === 1 ? { ...t, textHash: 'a'.repeat(64) } : t))],
  ])('sin aceptar las condiciones vigentes (%s) → 400 TERMS_NOT_ACCEPTED y no consume la invitación', async (_label, terms) => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    const acceptedTerms = typeof terms === 'function' ? terms() : terms;
    const error = await registration(prisma).service.register(validDto({ acceptedTerms }), META).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({ code: TERMS_NOT_ACCEPTED });
    expectNothingCreated(prisma);
    expect(prisma.__store.registrationInvite[0].usedAt).toBeNull();
  });

  it('registro válido: workspace + OWNER + evidencia de aceptación + auditoría, todo en una transacción', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    const { service, auth } = registration(prisma);
    await service.register(validDto(), META);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [user] = prisma.__store.user;
    const [workspace] = prisma.__store.workspace;
    expect(prisma.__store.workspaceMember).toEqual([expect.objectContaining({ userId: user.id, workspaceId: workspace.id, role: 'OWNER', isClinician: false })]);
    expect(prisma.__store.registrationInvite[0]).toMatchObject({ usedByUserId: user.id, workspaceId: workspace.id });
    expect(prisma.__store.registrationInvite[0].usedAt).toBeInstanceOf(Date);
    const docs = legalDocs.getCurrentLegalDocuments();
    expect(prisma.__store.termsAcceptance).toHaveLength(docs.length);
    for (const doc of docs) {
      expect(prisma.__store.termsAcceptance).toContainEqual(expect.objectContaining({
        workspaceId: workspace.id, userId: user.id, documentType: doc.type, version: doc.version, textHash: doc.textHash, ipAddress: META.ip, userAgent: META.userAgent,
      }));
    }
    const actions = prisma.__store.auditLog.map((a: any) => a.action).sort();
    expect(actions).toEqual([...docs.map(() => 'TERMS_ACCEPTED'), 'WORKSPACE_REGISTERED']);
    expect(prisma.__store.auditLog.every((a: any) => a.workspaceId === workspace.id && a.actorId === user.id)).toBe(true);
    expect(JSON.stringify(prisma.__store.auditLog)).not.toContain(TOKEN);
    expect(auth.issueSession).toHaveBeenCalledWith(expect.objectContaining({ id: user.id }), workspace.id, 'OWNER', META);
  });

  it('si falla la auditoría, rollback: ni cuenta ni evidencia, y la invitación sigue disponible', async () => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    prisma.auditLog.create.mockRejectedValueOnce(new Error('fallo de BD simulado'));
    await expect(registration(prisma).service.register(validDto(), META)).rejects.toThrow('fallo de BD simulado');
    expectNothingCreated(prisma);
    expect(prisma.__store.registrationInvite[0].usedAt).toBeNull();
  });

  it.each([[undefined, false], [false, false], [true, true]])('isClinician=%s → OWNER con isClinician=%s', async (input, expected) => {
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    await registration(prisma).service.register(validDto(input === undefined ? {} : { isClinician: input }), META);
    expect(prisma.__store.workspaceMember[0]).toMatchObject({ role: 'OWNER', isClinician: expected });
  });

  it('el token nunca se guarda en claro: solo su SHA-256', () => {
    expect(hashInviteToken(TOKEN)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashInviteToken(TOKEN)).not.toContain(TOKEN);
    expect(INVITE_TTL_MS).toBe(14 * DAY);
  });

  it('DTO con whitelist: rechaza campos extra (p. ej. role) y valida acceptedTerms', async () => {
    const opts = { whitelist: true, forbidNonWhitelisted: true };
    expect(await validate(plainToInstance(RegisterDto, validDto()), opts)).toEqual([]);
    const extra = await validate(plainToInstance(RegisterDto, validDto({ role: 'ADMIN' })), opts);
    expect(extra.map((e) => e.property)).toEqual(['role']);
    const bad = await validate(plainToInstance(RegisterDto, validDto({ acceptedTerms: [{ documentType: 'OTRO', version: '1', textHash: 'x' }] })), opts);
    expect(bad.map((e) => e.property)).toEqual(['acceptedTerms']);
    const clin = await validate(plainToInstance(RegisterDto, validDto({ isClinician: 'sí' })), opts);
    expect(clin.map((e) => e.property)).toEqual(['isClinician']);
  });

  it.each(['register', 'registerMember'])('%s tiene límite 5/min por IP', (handler) => {
    const fn = (AuthController.prototype as any)[handler];
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', fn)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', fn)).toBe(60_000);
  });

  it('ningún controlador ni servicio de la API crea invitaciones de registro (solo el CLI y el seed)', () => {
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir, { withFileTypes: true }).forEach((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.ts') && files.push(join(dir, d.name))));
    walk(join(__dirname, '..', 'src'));
    const writers = files.filter((f) => /registrationInvite\.create\b|createRegistrationInvite\(/.test(readFileSync(f, 'utf8')));
    expect(writers.map((f) => f.split('/src/')[1])).toEqual(['auth/invite-token.util.ts']);
    const importers = files.filter((f) => !f.endsWith('invite-token.util.ts') && readFileSync(f, 'utf8').includes('createRegistrationInvite'));
    expect(importers).toEqual([]);
  });
});

describe('Condiciones versionadas: guard 428 y nueva aceptación', () => {
  const WS = 'ws-1';
  const acceptedRows = (docs = legalDocs.getCurrentLegalDocuments(), userId = 'owner-1') =>
    docs.map((d, i) => ({ id: `ta-${i}`, workspaceId: WS, userId, documentType: d.type, version: d.version, textHash: d.textHash }));
  const owner = { sub: 'owner-1', workspaceId: WS, role: 'OWNER', email: 'owner@example.com' } as any;
  const members = [
    { id: 'm-1', workspaceId: WS, userId: 'owner-1', role: 'OWNER', isClinician: true },
    { id: 'm-2', workspaceId: WS, userId: 'admin-1', role: 'ADMIN', isClinician: false },
  ];
  /** Simula publicar una versión nueva de PILOT_TERMS (texto distinto → hash distinto). */
  function publishNewPilotVersion() {
    const current = legalDocs.getCurrentLegalDocuments();
    const next = current.map((d) => (d.type === 'PILOT_TERMS'
      ? { ...d, version: '0.2-borrador', text: `${d.text}\n(cambio)`, textHash: legalDocs.hashLegalText(`${d.text}\n(cambio)`) }
      : d));
    jest.spyOn(legalDocs, 'getCurrentLegalDocuments').mockReturnValue(next);
    return next;
  }

  it('con todo aceptado, el OWNER pasa', async () => {
    const prisma = fakeRegistrationDb({ termsAcceptance: acceptedRows() });
    await expect(assertTermsAccepted(prisma, owner, '/api/v1/patients')).resolves.toBeUndefined();
  });

  it('versión nueva publicada → 428 TERMS_ACCEPTANCE_REQUIRED con lo pendiente (sin texto)', async () => {
    const prisma = fakeRegistrationDb({ termsAcceptance: acceptedRows() });
    publishNewPilotVersion();
    const error = await assertTermsAccepted(prisma, owner, '/api/v1/patients').catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(428);
    expect(error.getResponse()).toMatchObject({ code: TERMS_ACCEPTANCE_REQUIRED, pending: [expect.objectContaining({ documentType: 'PILOT_TERMS', version: '0.2-borrador' })] });
    expect(error.getResponse().pending[0].text).toBeUndefined();
  });

  it('cambiar el texto sin subir la versión también obliga a aceptar (el hash forma parte)', async () => {
    const prisma = fakeRegistrationDb({ termsAcceptance: acceptedRows() });
    const current = legalDocs.getCurrentLegalDocuments();
    jest.spyOn(legalDocs, 'getCurrentLegalDocuments').mockReturnValue(current.map((d, i) => (i === 0 ? { ...d, textHash: 'b'.repeat(64) } : d)));
    await expect(assertTermsAccepted(prisma, owner, '/api/v1/patients')).rejects.toBeInstanceOf(HttpException);
  });

  it.each(['/api/v1/legal/terms', '/api/v1/legal/terms/status', '/api/v1/legal/terms/accept', '/api/v1/auth/logout', '/api/v1/auth/mfa/setup'])(
    'con condiciones pendientes el OWNER aún alcanza %s', async (path) => {
      const prisma = fakeRegistrationDb({ termsAcceptance: [] });
      await expect(assertTermsAccepted(prisma, owner, path)).resolves.toBeUndefined();
    });

  it.each(['ADMIN', 'THERAPIST', 'ASSISTANT'])('%s también queda bloqueado si no ha aceptado (cada profesional acepta por sí mismo)', async (role) => {
    const member = { ...owner, sub: `${role.toLowerCase()}-1`, role };
    // El titular ya aceptó: su aceptación NO cubre al miembro.
    const prisma = fakeRegistrationDb({ termsAcceptance: acceptedRows() });
    const error = await assertTermsAccepted(prisma, member, '/api/v1/patients').catch((e) => e);
    expect(error?.getStatus?.()).toBe(428);
    expect(error.getResponse()).toMatchObject({ code: TERMS_ACCEPTANCE_REQUIRED });
    const own = fakeRegistrationDb({ termsAcceptance: acceptedRows(undefined, member.sub) });
    await expect(assertTermsAccepted(own, member, '/api/v1/patients')).resolves.toBeUndefined();
  });

  it('los tokens sin rol de personal (portal) no pasan por este bloqueo; un token de personal sin sub → 401', async () => {
    const prisma = fakeRegistrationDb({ termsAcceptance: [] });
    await expect(assertTermsAccepted(prisma, { ...owner, role: 'PATIENT' }, '/api/v1/portal/dashboard')).resolves.toBeUndefined();
    await expect(assertTermsAccepted(prisma, undefined, '/api/v1/patients')).resolves.toBeUndefined();
    await expect(assertTermsAccepted(prisma, { ...owner, sub: undefined }, '/api/v1/patients')).rejects.toMatchObject({ status: 401 });
    expect(prisma.termsAcceptance.findMany).not.toHaveBeenCalled();
  });

  it('la aceptación de OTRO workspace no cuenta (multi-tenant)', async () => {
    const prisma = fakeRegistrationDb({ termsAcceptance: acceptedRows().map((r) => ({ ...r, workspaceId: 'ws-2' })) });
    await expect(assertTermsAccepted(prisma, owner, '/api/v1/patients')).rejects.toBeInstanceOf(HttpException);
  });

  it('JwtAuthGuard aplica el bloqueo tras autenticar (y falla cerrado sin BD)', async () => {
    jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate').mockResolvedValue(true);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ originalUrl: '/api/v1/patients', user: owner }) }) } as unknown as ExecutionContext;
    // El guard revalida antes la sesión: membresía ACTIVE en el workspace del token y tokenVersion.
    const session = { workspaceMember: [{ id: 'm-owner', workspaceId: WS, userId: 'owner-1', role: 'OWNER', isClinician: false }], user: [{ id: 'owner-1', email: 'owner@example.com' }] };
    const pendingDb = fakeRegistrationDb({ termsAcceptance: [], ...session });
    await expect(new JwtAuthGuard(pendingDb).canActivate(ctx)).rejects.toMatchObject({ status: 428 });
    await expect(new JwtAuthGuard(fakeRegistrationDb({ termsAcceptance: acceptedRows(), ...session })).canActivate(ctx)).resolves.toBe(true);
    await expect(new JwtAuthGuard(undefined).canActivate(ctx)).rejects.toMatchObject({ status: 500 });
  });

  it('el OWNER acepta la versión nueva: solo se registra lo pendiente, con auditoría en la transacción, y deja de recibir 428', async () => {
    const prisma = fakeRegistrationDb({ termsAcceptance: acceptedRows(), workspaceMember: members });
    const next = publishNewPilotVersion();
    const accepted = next.map((d) => ({ documentType: d.type, version: d.version, textHash: d.textHash }));
    const status = await new LegalService(prisma).accept(owner, { acceptedTerms: accepted } as any, META);
    expect(status).toMatchObject({ acceptanceRequired: false, canAccept: true, pending: [] });
    expect(prisma.$transaction).toHaveBeenCalled();
    const added = prisma.__store.termsAcceptance.filter((r: any) => r.version === '0.2-borrador');
    expect(added).toEqual([expect.objectContaining({ workspaceId: WS, userId: 'owner-1', documentType: 'PILOT_TERMS', ipAddress: META.ip })]);
    expect(prisma.__store.termsAcceptance).toHaveLength(next.length + 1);
    expect(prisma.__store.auditLog).toEqual([expect.objectContaining({
      workspaceId: WS, actorId: 'owner-1', action: 'TERMS_ACCEPTED', entityType: 'TermsAcceptance', entityId: added[0].id,
      metadata: { documentType: 'PILOT_TERMS', version: '0.2-borrador', textHash: added[0].textHash },
    })]);
    await expect(assertTermsAccepted(prisma, owner, '/api/v1/patients')).resolves.toBeUndefined();
  });

  it('aceptar con la versión anterior → 400 TERMS_NOT_ACCEPTED sin escribir', async () => {
    const prisma = fakeRegistrationDb({ termsAcceptance: acceptedRows(), workspaceMember: members });
    const old = currentTerms();
    publishNewPilotVersion();
    const error = await new LegalService(prisma).accept(owner, { acceptedTerms: old } as any, META).catch((e) => e);
    expect(error.getResponse()).toMatchObject({ code: TERMS_NOT_ACCEPTED });
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it('un miembro (ADMIN) acepta para sí mismo: evidencia con SU userId, auditada, y deja de recibir 428', async () => {
    const prisma = fakeRegistrationDb({ termsAcceptance: acceptedRows(), workspaceMember: members });
    const admin = { ...owner, sub: 'admin-1', role: 'ADMIN' };
    const before = await new LegalService(prisma).status(admin);
    expect(before).toMatchObject({ acceptanceRequired: true, canAccept: true });
    const status = await new LegalService(prisma).accept(admin, { acceptedTerms: currentTerms() } as any, META);
    expect(status).toMatchObject({ acceptanceRequired: false, pending: [] });
    const added = prisma.__store.termsAcceptance.filter((r: any) => r.userId === 'admin-1');
    expect(added).toHaveLength(legalDocs.getCurrentLegalDocuments().length);
    expect(added.every((r: any) => r.workspaceId === WS)).toBe(true);
    expect(prisma.__store.auditLog.every((a: any) => a.actorId === 'admin-1' && a.action === 'TERMS_ACCEPTED')).toBe(true);
    await expect(assertTermsAccepted(prisma, admin, '/api/v1/patients')).resolves.toBeUndefined();
  });

  it('quien no es miembro del workspace según la BD no acepta nada → 403 sin escribir', async () => {
    const prisma = fakeRegistrationDb({ workspaceMember: members });
    await expect(new LegalService(prisma).accept({ ...owner, sub: 'intruso-1', role: 'ADMIN' }, { acceptedTerms: currentTerms() } as any, META)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(new LegalService(prisma).accept({ ...owner, workspaceId: 'ws-2' }, { acceptedTerms: currentTerms() } as any, META)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.__store.termsAcceptance).toEqual([]);
  });

  it('aceptar es idempotente: sin pendientes no escribe ni audita', async () => {
    const prisma = fakeRegistrationDb({ termsAcceptance: acceptedRows(), workspaceMember: members });
    await new LegalService(prisma).accept(owner, { acceptedTerms: currentTerms() } as any, META);
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it('POST /legal/terms/accept: JWT + CSRF y 5/min', () => {
    const fn = LegalController.prototype.accept;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', fn)).toBe(5);
    const guards = Reflect.getMetadata('__guards__', fn).map((g: any) => g.name);
    expect(guards).toEqual(['JwtAuthGuard', 'CsrfGuard']);
  });

});

describe('Textos del piloto demo (demo-1.1) y datos del titular fuera de git', () => {
  // Datos 100 % ficticios: DNI de ejemplo con letra de control válida y un domicilio inventado.
  const FAKE_NIF = '12345678Z';
  const FAKE_ADDRESS = 'Calle Ficticia 1, 00000 Ciudad Inventada';
  const filledEnv = { LEGAL_TITULAR_NIF: FAKE_NIF, LEGAL_TITULAR_DOMICILIO: FAKE_ADDRESS } as any;

  it('vigentes: PILOT_TERMS y PRIVACY_PRODUCT demo-1.1; DPA_ART28 fuera durante el demo', () => {
    const docs = legalDocs.buildLegalDocuments({});
    expect(docs.map((d) => [d.type, d.version])).toEqual([['PILOT_TERMS', 'demo-1.1'], ['PRIVACY_PRODUCT', 'demo-1.1']]);
    expect(docs.map((d) => d.type)).not.toContain('DPA_ART28');
  });

  it('en git solo quedan sin rellenar [NIF] y [DOMICILIO]; el resto de datos decididos ya está', () => {
    for (const doc of legalDocs.buildLegalDocuments({})) {
      const markers = [...new Set(doc.text.match(/\[[A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ_ ]*\]/g) ?? [])].sort();
      expect(markers).toEqual(['[DOMICILIO]', '[NIF]']);
      expect(doc.text).not.toContain(legalDocs.PENDING_LEGAL_MARKER);
      expect(doc.text).toContain('asepsico1@gmail.com');
      expect(doc.text).toContain('En vigor desde el 17/10/2026');
      expect(doc.text).not.toMatch(/INICIO TEXTO CARGABLE|FIN TEXTO CARGABLE|Notas de carga|Lo que debe confirmar Argos/);
    }
    const terms = legalDocs.buildLegalDocuments({}).find((d) => d.type === 'PILOT_TERMS')!;
    expect(terms.text).toContain('juzgados y tribunales de Palencia');
    expect(terms.text).toContain('31/12/2026');
  });

  it('sin LEGAL_TITULAR_NIF / LEGAL_TITULAR_DOMICILIO los textos son borrador (marcadores = borrador)', () => {
    expect(legalDocs.buildLegalDocuments({}).every((d) => d.draft)).toBe(true);
    expect(legalDocs.buildLegalDocuments({ LEGAL_TITULAR_NIF: FAKE_NIF } as any).every((d) => d.draft)).toBe(true);
    expect(legalDocs.buildLegalDocuments({ LEGAL_TITULAR_DOMICILIO: FAKE_ADDRESS } as any).every((d) => d.draft)).toBe(true);
  });

  it('con ambos datos válidos: sin marcadores, no borrador y el hash es el del texto servido', () => {
    for (const doc of legalDocs.buildLegalDocuments(filledEnv)) {
      expect(doc.draft).toBe(false);
      expect(doc.text).not.toMatch(legalDocs.UNFILLED_MARKER_RE);
      expect(doc.text).toContain(`**NIF:** ${FAKE_NIF}`);
      expect(doc.text).toContain(FAKE_ADDRESS);
      expect(doc.textHash).toBe(legalDocs.hashLegalText(doc.text));
    }
  });

  it('cambiar el NIF o el domicilio cambia el hash (obliga a aceptar de nuevo)', () => {
    const a = legalDocs.buildLegalDocuments(filledEnv);
    const b = legalDocs.buildLegalDocuments({ ...filledEnv, LEGAL_TITULAR_DOMICILIO: 'Calle Inventada 2, 00000 Otra Ciudad' });
    expect(a.map((d) => d.textHash)).not.toEqual(b.map((d) => d.textHash));
  });

  it.each([
    ['NIF con letra de control incorrecta', { LEGAL_TITULAR_NIF: '12345678A' }],
    ['NIF con formato raro', { LEGAL_TITULAR_NIF: '[NIF]' }],
    ['domicilio con corchetes (inyección de marcador)', { LEGAL_TITULAR_DOMICILIO: 'Calle [DOMICILIO] 1, Ciudad' }],
    ['domicilio con Markdown o HTML', { LEGAL_TITULAR_DOMICILIO: 'Calle <b>Ficticia</b> 1, Ciudad' }],
    ['domicilio multilínea', { LEGAL_TITULAR_DOMICILIO: 'Calle Ficticia 1\n# Título inyectado' }],
    ['domicilio demasiado corto', { LEGAL_TITULAR_DOMICILIO: 'C/ 1' }],
  ])('valor no válido (%s) → no se sustituye y el documento sigue en borrador', (_label, extra) => {
    const docs = legalDocs.buildLegalDocuments({ ...filledEnv, ...extra });
    expect(docs.every((d) => d.draft)).toBe(true);
  });

  it('normalizeNif acepta DNI y NIE válidos (ficticios) y normaliza espacios y guiones', () => {
    expect(legalDocs.normalizeNif(' 12345678-z ')).toBe('12345678Z');
    expect(legalDocs.normalizeNif('X1234567L')).toBe('X1234567L');
    expect(legalDocs.normalizeNif('X1234567A')).toBeNull();
  });

  it('cualquier marcador [EN MAYÚSCULAS] cuenta como borrador; los enlaces normales no', () => {
    expect(legalDocs.isDraftLegalText('Hola [FECHA_VIGENCIA]')).toBe(true);
    expect(legalDocs.isDraftLegalText('Hola [PENDIENTE DEL DESPACHO]')).toBe(true);
    expect(legalDocs.isDraftLegalText('Hola [Más información] y (BETA)')).toBe(false);
  });

  it('el repositorio no contiene NIF ni domicilio: el texto en git deja los marcadores', () => {
    const dir = join(__dirname, '..', 'src', 'legal', 'texts');
    for (const file of ['pilot-terms.ts', 'privacy-product.ts']) {
      const src = readFileSync(join(dir, file), 'utf8');
      expect(src).toContain('**NIF:** [NIF]');
      expect(src).toMatch(/\*\*Domicilio:\*\* \[DOMICILIO\]/);
      expect(src).not.toMatch(/\b[0-9XYZ][0-9]{7}[A-Z]\b/);
    }
  });
});

describe('GET /environment (aviso fijo de entorno de prueba)', () => {
  it.each([[undefined, true], ['', true], ['true', true], ['TRUE', true], ['0', true], ['False', true], ['false', false]])(
    'DEMO_ENVIRONMENT=%j → demo=%s (solo "false" exacto lo quita)', (value, expected) => {
      expect(isDemoEnvironment(value === undefined ? {} : { DEMO_ENVIRONMENT: value } as any)).toBe(expected);
    });

  it('es público, sin guards, y solo devuelve { demo }', () => {
    expect(Reflect.getMetadata('__guards__', EnvironmentController)).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', EnvironmentController.prototype.get)).toBeUndefined();
    expect(Object.keys(new EnvironmentController().get())).toEqual(['demo']);
  });
});

describe('Invitar miembros a un workspace existente', () => {
  const WS = 'ws-1';
  const members = [
    { id: 'm-owner', workspaceId: WS, userId: 'owner-1', role: 'OWNER', isClinician: false },
    { id: 'm-admin', workspaceId: WS, userId: 'admin-1', role: 'ADMIN', isClinician: false },
    { id: 'm-ther', workspaceId: WS, userId: 'ther-1', role: 'THERAPIST', isClinician: true },
    { id: 'm-asst', workspaceId: WS, userId: 'asst-1', role: 'ASSISTANT', isClinician: false },
    { id: 'm-ws2', workspaceId: 'ws-2', userId: 'owner-2', role: 'OWNER', isClinician: false },
  ];
  const users = [{ id: 'ther-1', email: 'terapeuta@example.com' }, { id: 'owner-2', email: 'otro-titular@example.com' }];
  const actor = (sub: string, role: string, workspaceId = WS) => ({ sub, workspaceId, role, email: `${sub}@example.com` }) as any;
  const db = (extra: Record<string, any[]> = {}) => fakeRegistrationDb({ workspaceMember: members, user: users, ...extra });

  it.each([
    ['THERAPIST', undefined, true],
    ['THERAPIST', true, true],
    ['ASSISTANT', undefined, false],
    ['ASSISTANT', false, false],
    ['ADMIN', undefined, false],
    ['ADMIN', true, true],
  ])('OWNER invita %s (isClinician=%s) → invitación con isClinician=%s, auditada en la transacción', async (role, requested, expected) => {
    const prisma = db();
    const result: any = await new WorkspaceInvitesService(prisma).create(WS, actor('owner-1', 'OWNER'), { email: 'Nueva@Example.com', role, isClinician: requested } as any, META);
    expect(result).toMatchObject({ email: 'nueva@example.com', role, isClinician: expected });
    expect(result.inviteUrl).toMatch(/\/join#invite=[A-Za-z0-9_-]{43}$/);
    expect(result.tokenHash).toBeUndefined();
    expect(prisma.__store.workspaceInvite).toEqual([expect.objectContaining({ workspaceId: WS, role, isClinician: expected, invitedById: 'owner-1' })]);
    expect(prisma.__store.workspaceInvite[0].tokenHash).toBe(hashInviteToken(result.inviteUrl.split('#invite=')[1]));
    expect(prisma.__store.auditLog).toEqual([expect.objectContaining({ workspaceId: WS, actorId: 'owner-1', action: 'MEMBER_INVITED', metadata: { role, isClinician: expected } })]);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it.each([['THERAPIST', false], ['ASSISTANT', true]])('rol/isClinician incoherente (%s, isClinician=%s) → 400 sin escribir', async (role, requested) => {
    const prisma = db();
    await expect(new WorkspaceInvitesService(prisma).create(WS, actor('owner-1', 'OWNER'), { email: 'x@example.com', role, isClinician: requested } as any, META)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.__store.workspaceInvite).toEqual([]);
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it('la BD también lo impide (CHECK): THERAPIST no clínico, ASSISTANT clínico, OWNER', async () => {
    const prisma = db();
    const base = { workspaceId: WS, email: 'x@example.com', tokenHash: 'h', expiresAt: new Date() };
    await expect(prisma.workspaceInvite.create({ data: { ...base, role: 'THERAPIST', isClinician: false } })).rejects.toThrow(/therapist_is_clinician/);
    await expect(prisma.workspaceInvite.create({ data: { ...base, role: 'ASSISTANT', isClinician: true } })).rejects.toThrow(/assistant_not_clinician/);
    await expect(prisma.workspaceInvite.create({ data: { ...base, role: 'OWNER', isClinician: false } })).rejects.toThrow(/not_owner/);
  });

  it('el DTO nunca acepta OWNER como rol ni campos extra', async () => {
    const opts = { whitelist: true, forbidNonWhitelisted: true };
    expect((await validate(plainToInstance(CreateMemberInviteDto, { email: 'x@example.com', role: 'OWNER' }), opts)).map((e) => e.property)).toEqual(['role']);
    expect((await validate(plainToInstance(CreateMemberInviteDto, { email: 'x@example.com', role: 'ADMIN', workspaceId: 'ws-2' }), opts)).map((e) => e.property)).toEqual(['workspaceId']);
  });

  it.each([['ADMIN', 'admin-1'], ['THERAPIST', 'ther-1'], ['ASSISTANT', 'asst-1']])('%s no puede invitar → 403', async (role, sub) => {
    const prisma = db();
    await expect(new WorkspaceInvitesService(prisma).create(WS, actor(sub, role), { email: 'x@example.com', role: 'ASSISTANT' } as any, META)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.__store.workspaceInvite).toEqual([]);
  });

  it('token con rol OWNER pero la BD dice ADMIN → 403 (decide la BD)', async () => {
    await expect(new WorkspaceInvitesService(db()).create(WS, actor('admin-1', 'OWNER'), { email: 'x@example.com', role: 'ASSISTANT' } as any, META)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('invitar a alguien que ya está en el equipo → 400; un correo de OTRO workspace no se revela', async () => {
    const service = new WorkspaceInvitesService(db());
    await expect(service.create(WS, actor('owner-1', 'OWNER'), { email: 'terapeuta@example.com', role: 'THERAPIST' } as any, META)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(WS, actor('owner-1', 'OWNER'), { email: 'otro-titular@example.com', role: 'THERAPIST' } as any, META)).resolves.toBeDefined();
  });

  it('una invitación nueva al mismo correo revoca la anterior', async () => {
    const prisma = db();
    const service = new WorkspaceInvitesService(prisma);
    await service.create(WS, actor('owner-1', 'OWNER'), { email: 'x@example.com', role: 'ASSISTANT' } as any, META);
    await service.create(WS, actor('owner-1', 'OWNER'), { email: 'x@example.com', role: 'THERAPIST' } as any, META);
    const [first, second] = prisma.__store.workspaceInvite;
    expect(first.revokedAt).toBeInstanceOf(Date);
    expect(second.revokedAt).toBeUndefined();
  });

  it('revocar una invitación de OTRO workspace → 404 sin escribir (filtro por workspaceId)', async () => {
    const prisma = db({ workspaceInvite: [{ id: 'wi-2', workspaceId: 'ws-2', email: 'x@example.com', role: 'ASSISTANT', isClinician: false, tokenHash: 'h2', expiresAt: new Date(Date.now() + DAY), acceptedAt: null, revokedAt: null }] });
    await expect(new WorkspaceInvitesService(prisma).revoke(WS, actor('owner-1', 'OWNER'), 'wi-2', META)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.__store.workspaceInvite[0].revokedAt).toBeNull();
    expect(prisma.workspaceInvite.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'wi-2', workspaceId: WS }) }));
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it('el listado (OWNER/ADMIN) es solo del workspace y nunca lleva tokenHash', async () => {
    const prisma = db({ workspaceInvite: [
      { id: 'wi-1', workspaceId: WS, email: 'a@example.com', role: 'ASSISTANT', isClinician: false, tokenHash: 'h1', expiresAt: new Date(), createdAt: new Date() },
      { id: 'wi-2', workspaceId: 'ws-2', email: 'b@example.com', role: 'ASSISTANT', isClinician: false, tokenHash: 'h2', expiresAt: new Date(), createdAt: new Date() },
    ] });
    await new WorkspaceInvitesService(prisma).list(WS, actor('admin-1', 'ADMIN'));
    const args = prisma.workspaceInvite.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId: WS });
    expect(args.select.tokenHash).toBeUndefined();
    await expect(new WorkspaceInvitesService(prisma).list(WS, actor('ther-1', 'THERAPIST'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('las rutas de invitaciones van con JWT + CSRF (guards del controlador)', () => {
    const guards = Reflect.getMetadata('__guards__', WorkspaceMembersController).map((g: any) => g.name);
    expect(guards).toEqual(['JwtAuthGuard', 'CsrfGuard']);
  });

  describe('POST /auth/register/member', () => {
    const MEMBER_TOKEN = 'token-ficticio-de-miembro-0123456789abcdefghijklm';
    const memberInvite = (extra: Record<string, unknown> = {}) => ({
      id: 'wi-1', workspaceId: WS, tokenHash: hashInviteToken(MEMBER_TOKEN), email: 'nuevo@example.com', role: 'THERAPIST', isClinician: true,
      invitedById: 'owner-1', expiresAt: new Date(Date.now() + 14 * DAY), acceptedAt: null, revokedAt: null, ...extra,
    });
    const memberDto = (extra: Record<string, unknown> = {}) => ({ firstName: 'Nuevo', lastName: 'Ficticio', email: 'nuevo@example.com', password: 'contrasena-ficticia-larga', inviteToken: MEMBER_TOKEN, acceptedTerms: currentTerms(), ...extra }) as any;

    it.each([['THERAPIST', true], ['ASSISTANT', false], ['ADMIN', true], ['ADMIN', false]])(
      'alta como %s (isClinician=%s): membresía coherente en el workspace de la invitación, auditada', async (role, isClinician) => {
        const prisma = db({ workspaceInvite: [memberInvite({ role, isClinician })] });
        const { service, auth } = registration(prisma);
        await service.registerMember(memberDto(), META);
        const user = prisma.__store.user.find((u: any) => u.email === 'nuevo@example.com');
        expect(prisma.__store.workspaceMember).toContainEqual(expect.objectContaining({ workspaceId: WS, userId: user.id, role, isClinician }));
        expect(prisma.__store.workspaceInvite[0]).toMatchObject({ acceptedUserId: user.id });
        expect(prisma.__store.auditLog.filter((a: any) => a.action === 'MEMBER_JOINED')).toEqual([expect.objectContaining({ workspaceId: WS, actorId: user.id, metadata: expect.objectContaining({ workspaceInviteId: 'wi-1', role, isClinician }) })]);
        // El miembro acepta las condiciones vigentes: evidencia propia, en el workspace de la invitación, auditada.
        const docs = legalDocs.getCurrentLegalDocuments();
        expect(prisma.__store.termsAcceptance).toHaveLength(docs.length);
        for (const doc of docs) {
          expect(prisma.__store.termsAcceptance).toContainEqual(expect.objectContaining({ workspaceId: WS, userId: user.id, documentType: doc.type, version: doc.version, textHash: doc.textHash, ipAddress: META.ip }));
        }
        expect(prisma.__store.auditLog.filter((a: any) => a.action === 'TERMS_ACCEPTED')).toHaveLength(docs.length);
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.__store.workspace).toEqual([]);
        expect(auth.issueSession).toHaveBeenCalledWith(expect.anything(), WS, role, META);
      });

    it.each([
      ['sin token', {}, { inviteToken: undefined }],
      ['ya usada', { acceptedAt: new Date() }, {}],
      ['revocada', { revokedAt: new Date() }, {}],
      ['caducada', { expiresAt: new Date(Date.now() - 1000) }, {}],
      ['de otro correo', {}, { email: 'intruso@example.com' }],
    ])('invitación %s → 400 neutro sin crear nada', async (_label, inviteExtra, dtoExtra) => {
      const prisma = db({ workspaceInvite: [memberInvite(inviteExtra)] });
      await expectNeutral(registration(prisma).service.registerMember(memberDto(dtoExtra), META));
      expect(prisma.__store.user).toEqual(users);
      expect(prisma.__store.workspaceMember).toEqual(members);
      expect(prisma.__store.auditLog).toEqual([]);
    });

    it.each([
      ['sin acceptedTerms', undefined],
      ['lista vacía', []],
      ['falta un documento', () => currentTerms().slice(1)],
      ['hash de otro texto', () => currentTerms().map((t, i) => (i === 0 ? { ...t, textHash: 'c'.repeat(64) } : t))],
    ])('sin aceptar las condiciones vigentes (%s) → 400 TERMS_NOT_ACCEPTED, sin crear nada ni consumir la invitación', async (_label, terms) => {
      const prisma = db({ workspaceInvite: [memberInvite()] });
      const acceptedTerms = typeof terms === 'function' ? terms() : terms;
      const error = await registration(prisma).service.registerMember(memberDto({ acceptedTerms }), META).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: TERMS_NOT_ACCEPTED });
      expect(prisma.__store.user).toEqual(users);
      expect(prisma.__store.termsAcceptance).toEqual([]);
      expect(prisma.__store.workspaceInvite[0].acceptedAt).toBeNull();
    });

    it('si falla la evidencia de aceptación, rollback completo y la invitación sigue disponible', async () => {
      const prisma = db({ workspaceInvite: [memberInvite()] });
      prisma.termsAcceptance.create.mockRejectedValueOnce(new Error('fallo de BD simulado'));
      await expect(registration(prisma).service.registerMember(memberDto(), META)).rejects.toThrow('fallo de BD simulado');
      expect(prisma.__store.user).toEqual(users);
      expect(prisma.__store.workspaceMember).toEqual(members);
      expect(prisma.__store.workspaceInvite[0].acceptedAt).toBeNull();
    });

    it('DTO de miembro con whitelist: valida acceptedTerms y rechaza campos extra (role)', async () => {
      const opts = { whitelist: true, forbidNonWhitelisted: true };
      expect(await validate(plainToInstance(RegisterMemberDto, memberDto()), opts)).toEqual([]);
      expect((await validate(plainToInstance(RegisterMemberDto, memberDto({ role: 'OWNER' })), opts)).map((e) => e.property)).toEqual(['role']);
      expect((await validate(plainToInstance(RegisterMemberDto, memberDto({ acceptedTerms: [{ documentType: 'OTRO', version: '1', textHash: 'x' }] })), opts)).map((e) => e.property)).toEqual(['acceptedTerms']);
    });

    it('una cuenta que ya existe (en cualquier workspace) → neutro', async () => {
      const prisma = db({ workspaceInvite: [memberInvite({ email: 'otro-titular@example.com' })] });
      await expectNeutral(registration(prisma).service.registerMember(memberDto({ email: 'otro-titular@example.com' }), META));
    });

    it('el token de miembro no sirve para crear un workspace (y viceversa)', async () => {
      const prisma = db({ workspaceInvite: [memberInvite()] });
      await expectNeutral(registration(prisma).service.register(validDto({ email: 'nuevo@example.com', inviteToken: MEMBER_TOKEN }), META));
      const prisma2 = fakeRegistrationDb({ registrationInvite: [invite()] });
      await expectNeutral(registration(prisma2).service.registerMember(memberDto({ email: EMAIL, inviteToken: TOKEN }), META));
    });
  });
});

describe('Condiciones en borrador con NODE_ENV=production (condición de Argos)', () => {
  const ENV = { ...process.env };
  afterEach(() => { process.env = { ...ENV }; });
  const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER', email: 'owner@example.com' } as any;
  const ownerDb = () => fakeRegistrationDb({ workspaceMember: [{ id: 'm-1', workspaceId: 'ws-1', userId: 'owner-1', role: 'OWNER', isClinician: false }] });

  async function expect503(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (e) => e);
    expect(error?.getStatus?.()).toBe(503);
    expect(error.getResponse()).toMatchObject({ statusCode: 503, code: LEGAL_TERMS_DRAFT, drafts: ['PILOT_TERMS', 'PRIVACY_PRODUCT'] });
  }

  it('registro → 503 LEGAL_TERMS_DRAFT sin crear nada ni consumir la invitación', async () => {
    process.env.NODE_ENV = 'production';
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    await expect503(registration(prisma).service.register(validDto(), META));
    expectNothingCreated(prisma);
    expect(prisma.__store.registrationInvite[0].usedAt).toBeNull();
  });

  it('aceptar condiciones → 503 LEGAL_TERMS_DRAFT sin escribir', async () => {
    process.env.NODE_ENV = 'production';
    const prisma = ownerDb();
    await expect503(new LegalService(prisma).accept(owner, { acceptedTerms: currentTerms() } as any, META));
    expect(prisma.__store.termsAcceptance).toEqual([]);
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it.each(['true', '1', 'TRUE', 'yes', ''])('LEGAL_ALLOW_DRAFT=%j ya no existe: no desbloquea nada (ni con "true")', async (value) => {
    process.env.NODE_ENV = 'production';
    process.env.LEGAL_ALLOW_DRAFT = value;
    await expect503(registration(fakeRegistrationDb({ registrationInvite: [invite()] })).service.register(validDto(), META));
    await expect503(new LegalService(ownerDb()).accept(owner, { acceptedTerms: currentTerms() } as any, META));
  });

  it('alta de miembro con borradores → 503 sin crear nada ni consumir la invitación', async () => {
    process.env.NODE_ENV = 'production';
    const MT = 'token-ficticio-de-miembro-en-produccion-0123456789ab';
    const prisma = fakeRegistrationDb({ workspaceInvite: [{ id: 'wi-1', workspaceId: 'ws-1', tokenHash: hashInviteToken(MT), email: 'm@example.com', role: 'ASSISTANT', isClinician: false, invitedById: 'owner-1', expiresAt: new Date(Date.now() + DAY), acceptedAt: null, revokedAt: null }] });
    await expect503(registration(prisma).service.registerMember({ firstName: 'Miem', lastName: 'Bro', email: 'm@example.com', password: 'contrasena-ficticia-larga', inviteToken: MT, acceptedTerms: currentTerms() } as any, META));
    expect(prisma.__store.user).toEqual([]);
    expect(prisma.__store.workspaceInvite[0].acceptedAt).toBeNull();
  });

  it('en producción, con [NIF] sin rellenar (sin LEGAL_TITULAR_NIF) → 503 aunque el domicilio esté', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(legalDocs, 'getCurrentLegalDocuments').mockReturnValue(legalDocs.buildLegalDocuments({ LEGAL_TITULAR_DOMICILIO: 'Calle Ficticia 1, 00000 Ciudad Inventada' } as any));
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    await expect503(registration(prisma).service.register(validDto(), META));
    expectNothingCreated(prisma);
  });

  it('fuera de producción (local, CI) los borradores no bloquean', async () => {
    process.env.NODE_ENV = 'test';
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    await registration(prisma).service.register(validDto(), META);
    expect(prisma.__store.user).toHaveLength(1);
  });

  it('en producción con NIF y domicilio rellenados por el entorno (sin marcadores) no hay 503', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(legalDocs, 'getCurrentLegalDocuments').mockReturnValue(legalDocs.buildLegalDocuments({ LEGAL_TITULAR_NIF: '12345678Z', LEGAL_TITULAR_DOMICILIO: 'Calle Ficticia 1, 00000 Ciudad Inventada' } as any));
    const prisma = fakeRegistrationDb({ registrationInvite: [invite()] });
    await registration(prisma).service.register(validDto(), META);
    expect(prisma.__store.user).toHaveLength(1);
  });

  it('.env.example: NIF y domicilio vacíos (nunca valores en el repo), sin LEGAL_ALLOW_DRAFT y con DEMO_ENVIRONMENT', () => {
    const example = readFileSync(join(__dirname, '..', '..', '..', '.env.example'), 'utf8');
    expect(example).toMatch(/^LEGAL_TITULAR_NIF=$/m);
    expect(example).toMatch(/^LEGAL_TITULAR_DOMICILIO=$/m);
    expect(example).not.toMatch(/^LEGAL_ALLOW_DRAFT=/m);
    expect(example).toMatch(/^DEMO_ENVIRONMENT=true$/m);
    expect(example).toContain('LEGAL_TERMS_DRAFT');
  });
});

describe('Miembro que entra por invitación (condiciones de Argos)', () => {
  const WS = 'ws-1';
  const TOKEN_M = 'token-ficticio-de-miembro-terapeuta-0123456789abcdefg';
  const db = () => fakeRegistrationDb({
    workspaceMember: [{ id: 'm-owner', workspaceId: WS, userId: 'owner-1', role: 'OWNER', isClinician: false }],
    workspaceInvite: [{ id: 'wi-1', workspaceId: WS, tokenHash: hashInviteToken(TOKEN_M), email: 'tera@example.com', role: 'THERAPIST', isClinician: true, invitedById: 'owner-1', expiresAt: new Date(Date.now() + DAY), acceptedAt: null, revokedAt: null }],
  });
  const dto = () => ({ firstName: 'Tera', lastName: 'Ficticia', email: 'tera@example.com', password: 'contrasena-ficticia-larga', inviteToken: TOKEN_M, acceptedTerms: currentTerms() }) as any;

  it('un THERAPIST recién invitado recibe 403 de MFA antes de tocar datos clínicos', async () => {
    const prisma = db();
    const jwt = new JwtService({ secret: 'secreto-solo-para-tests', signOptions: { expiresIn: '15m' } });
    const service = new RegistrationService(prisma, new AuthService(prisma, jwt, {} as any));
    const session: any = await service.registerMember(dto(), META);
    const payload = await jwt.verifyAsync(session.accessToken);
    expect(payload).toMatchObject({ role: 'THERAPIST', workspaceId: WS, mfaEnabled: false });
    const guard = new JwtAuthGuard();
    for (const url of ['/api/v1/patients', '/api/v1/patients/p-1/history', '/api/v1/clinical-processes', '/api/v1/sessions', '/api/v1/messages/c-1', '/api/v1/legal/terms/status']) {
      const ctx = { switchToHttp: () => ({ getRequest: () => ({ originalUrl: url, url }) }) } as unknown as ExecutionContext;
      expect(() => guard.handleRequest(null, payload, null, ctx)).toThrow(/verificación en dos pasos/);
    }
    const setupCtx = { switchToHttp: () => ({ getRequest: () => ({ originalUrl: '/api/v1/auth/mfa/setup' }) }) } as unknown as ExecutionContext;
    expect(guard.handleRequest(null, payload, null, setupCtx)).toBeTruthy();
  });

  it('recibe la política de privacidad vigente (art. 13), la acepta y queda auditada la versión informada', async () => {
    const prisma = db();
    const session: any = await registration(prisma).service.registerMember(dto(), META);
    const privacy = legalDocs.getCurrentLegalDocuments().find((d) => d.type === 'PRIVACY_PRODUCT')!;
    expect(session.privacyNotice).toEqual(expect.objectContaining({ documentType: 'PRIVACY_PRODUCT', version: privacy.version, textHash: privacy.textHash, text: privacy.text }));
    expect(prisma.__store.termsAcceptance).toContainEqual(expect.objectContaining({ documentType: 'PRIVACY_PRODUCT', version: privacy.version, textHash: privacy.textHash }));
    const joined = prisma.__store.auditLog.find((a: any) => a.action === 'MEMBER_JOINED');
    expect(joined.metadata).toMatchObject({ privacyNoticeVersion: privacy.version, privacyNoticeHash: privacy.textHash });
  });

  it('el controlador devuelve privacyNotice en POST /auth/register/member', async () => {
    const registrationMock: any = { registerMember: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: new Date(), user: { id: 'u' }, workspaceId: WS, role: 'THERAPIST', privacyNotice: { documentType: 'PRIVACY_PRODUCT' } })) };
    const controller = new AuthController({} as any, {} as any, registrationMock);
    const res: any = { cookie: jest.fn() };
    const body: any = await controller.registerMember(dto(), { ip: '1', get: () => 'jest' } as any, res);
    expect(body.privacyNotice).toEqual({ documentType: 'PRIVACY_PRODUCT' });
    expect(body.accessToken).toBeUndefined();
  });

  it('DELETE /workspace-members/invites/:id tiene throttle propio', () => {
    const fn = WorkspaceMembersController.prototype.revokeInvite;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', fn)).toBe(20);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', fn)).toBe(60_000);
  });
});

describe('Migración registro_por_invitacion', () => {
  const dir = join(__dirname, '..', 'prisma', 'migrations');
  const name = readdirSync(dir).find((d) => d.endsWith('_registro_por_invitacion'));
  const sql = name ? readFileSync(join(dir, name, 'migration.sql'), 'utf8') : '';

  it('crea las tablas con el token solo como hash único y los CHECK de rol/isClinician', () => {
    expect(name).toBeDefined();
    expect(sql).toContain('CREATE TABLE "RegistrationInvite"');
    expect(sql).toContain('CREATE TABLE "WorkspaceInvite"');
    expect(sql).toContain('CREATE TABLE "TermsAcceptance"');
    expect(sql).toContain('CREATE UNIQUE INDEX "RegistrationInvite_tokenHash_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "WorkspaceInvite_tokenHash_key"');
    expect(sql).not.toMatch(/"token" TEXT/);
    expect(sql).toMatch(/CHECK \("role" <> 'OWNER'\)/);
    expect(sql).toMatch(/CHECK \(NOT \("role" = 'ASSISTANT' AND "isClinician"\)\)/);
    expect(sql).toMatch(/CHECK \(NOT \("role" = 'THERAPIST' AND NOT "isClinician"\)\)/);
    expect(sql).toMatch(/"TermsAcceptance_workspaceId_fkey"[^;]*ON DELETE RESTRICT/);
  });
});
