import { PrismaClient } from '@prisma/client';
import { IntakeLinksService } from '../src/portal-signup/intake-links.service';
import { SignupRequestsService } from '../src/portal-signup/signup-requests.service';
import { PortalActivationService } from '../src/portal-signup/portal-activation.service';
import { MAX_REQUESTS_PER_LINK_PER_HOUR, PORTAL_SIGNUP_NOTICE_VERSIONS } from '../src/portal-signup/portal-signup.config';

/**
 * Alta por QR contra PostgreSQL REAL: consumo atómico del enlace de activación, resolución
 * concurrente de una misma solicitud, límite por QR con advisory lock y CHECK de la BD.
 *
 * Igual que booking-race: solo se ejecuta con RACE_DATABASE_URL (BD DESECHABLE ya migrada); con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Datos ficticios, no se borran.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de alta por QR no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

describeDb('Alta por QR (PostgreSQL real)', () => {
  let prisma: PrismaClient;
  const run = `signup-race-${Date.now()}`;
  let workspaceId: string;
  let therapistId: string;
  const therapist = () => ({ sub: therapistId, workspaceId, role: 'THERAPIST', email: `${run}@example.com` }) as any;
  const body = (token: string, i: number) => ({
    token, firstName: 'Paciente', lastName: `Ficticio ${i}`, email: `${run}-${i}@example.com`, birthDate: '1990-01-01',
    privacyNoticeAcknowledged: true, portalTermsAccepted: true,
    privacyNoticeVersion: PORTAL_SIGNUP_NOTICE_VERSIONS.privacyNotice, portalTermsVersion: PORTAL_SIGNUP_NOTICE_VERSIONS.portalTerms,
  }) as any;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const workspace = await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}` } });
    const user = await prisma.user.create({ data: { email: `${run}@example.com`, passwordHash: 'hash-ficticio', firstName: 'Profesional', lastName: 'Ficticio' } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'THERAPIST', isClinician: true } });
    workspaceId = workspace.id; therapistId = user.id;
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it(`envíos simultáneos por un mismo QR: como mucho ${MAX_REQUESTS_PER_LINK_PER_HOUR} solicitudes (advisory lock)`, async () => {
    const { token } = await new IntakeLinksService(prisma as any).rotate(workspaceId, therapist(), 'me');
    await Promise.all(Array.from({ length: MAX_REQUESTS_PER_LINK_PER_HOUR + 6 }, (_, i) => new SignupRequestsService(prisma as any).submit(body(token, i))));
    expect(await prisma.portalSignupRequest.count({ where: { workspaceId } })).toBe(MAX_REQUESTS_PER_LINK_PER_HOUR);
  });

  it('dos personas resuelven la misma solicitud a la vez: solo una prospera y hay una sola cuenta', async () => {
    const [request] = await prisma.portalSignupRequest.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, take: 1 });
    const service = () => new SignupRequestsService(prisma as any);
    const results = await Promise.allSettled([
      service().acceptCreatingPatient(workspaceId, therapist(), request.id),
      service().acceptCreatingPatient(workspaceId, therapist(), request.id),
      service().reject(workspaceId, therapist(), request.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.portalSignupRequest.count({ where: { id: request.id } })).toBe(0);
    const accepted = results.find((r) => r.status === 'fulfilled' && (r.value as any)?.patientId) as PromiseFulfilledResult<any> | undefined;
    if (accepted) expect(await prisma.patientPortalAccount.count({ where: { workspaceId, patientId: accepted.value.patientId } })).toBe(1);
  });

  it('el mismo enlace de activación canjeado 5 veces a la vez: exactamente 1 éxito', async () => {
    const [request] = await prisma.portalSignupRequest.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, take: 1 });
    const accepted = await new SignupRequestsService(prisma as any).acceptCreatingPatient(workspaceId, therapist(), request.id);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) =>
      new PortalActivationService(prisma as any).redeem({ token: accepted.activation.token, password: `ClaveFicticia${i}A` })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const account = await prisma.patientPortalAccount.findFirstOrThrow({ where: { id: accepted.portalAccountId, workspaceId } });
    expect(account).toMatchObject({ isActive: true, pendingActivation: false, mustChangePassword: false });
  });

  it('la BD impide una cuenta pendiente y activa a la vez (CHECK)', async () => {
    const account = await prisma.patientPortalAccount.findFirstOrThrow({ where: { workspaceId, isActive: true } });
    await expect(prisma.patientPortalAccount.updateMany({ where: { id: account.id, workspaceId }, data: { pendingActivation: true } })).rejects.toThrow();
  });
});
