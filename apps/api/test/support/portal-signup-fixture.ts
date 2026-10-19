import { fakeClinicalDb } from './fake-clinical-db';
import { IntakeLinksService } from '../../src/portal-signup/intake-links.service';
import { SignupRequestsService } from '../../src/portal-signup/signup-requests.service';
import { PortalActivationService } from '../../src/portal-signup/portal-activation.service';
import { PORTAL_SIGNUP_NOTICE_VERSIONS } from '../../src/portal-signup/portal-signup.config';

/** Escenario común de los tests del alta por QR. Datos 100 % ficticios. */
export const WS = 'ws-1';
export const staff = (sub: string, role: string, workspaceId = WS) => ({ sub, role, workspaceId, email: `${sub}@example.com` }) as any;
export const owner = staff('owner-1', 'OWNER');
export const assistant = staff('assistant-1', 'ASSISTANT');
export const therapistA = staff('t-a', 'THERAPIST');
export const therapistB = staff('t-b', 'THERAPIST');
export const ownerWs2 = staff('owner-2', 'OWNER', 'ws-2');
export const ADULT_BIRTH = '1990-04-15';

export function seed(overrides: Record<string, any[]> = {}) {
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
      { id: 'p-ws2', workspaceId: 'ws-2', firstName: 'Lucía', lastName: 'Ficticia Prueba', birthDate: new Date(`${ADULT_BIRTH}T00:00:00Z`), status: 'ACTIVE', portalAccessMode: 'PATIENT_ONLY', deletedAt: null },
    ],
    clinicalProcess: [
      { id: 'proc-1', workspaceId: WS, patientId: 'p1', therapistId: 't-a', status: 'ACTIVE' },
      { id: 'proc-x', workspaceId: 'ws-2', patientId: 'p-ws2', therapistId: 't-x', status: 'ACTIVE' },
    ],
    patientPortalAccount: [],
    ...overrides,
  } as any);
}

export const rows = (prisma: any, model: string) => (prisma.__store[model] ?? []) as any[];
export const audits = (prisma: any, action?: string) => rows(prisma, 'auditLog').filter((a) => !action || a.action === action);
export const services = (prisma: any) => ({
  links: new IntakeLinksService(prisma),
  requests: new SignupRequestsService(prisma),
  activation: new PortalActivationService(prisma),
});

export const body = (token: string, extra: Record<string, unknown> = {}) => ({
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

export async function withLink(prisma: any, professional = therapistA) {
  const { token } = await services(prisma).links.rotate(professional.workspaceId, professional, 'me');
  return token;
}

export async function pendingRequest(prisma: any, professional = therapistA, extra: Record<string, unknown> = {}) {
  const token = await withLink(prisma, professional);
  await services(prisma).requests.submit(body(token, extra) as any);
  const req = rows(prisma, 'portalSignupRequest').at(-1);
  if (!req) throw new Error('No se creó la solicitud de prueba');
  return { token, requestId: req.id as string };
}

export const codeOf = (error: any) => error?.getResponse?.()?.code;
