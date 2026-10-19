import { NotFoundException } from '@nestjs/common';
import { MemberRemovalService } from '../src/workspace-members/member-removal.service';
import { SIGNUP_ACCEPTED_RESPONSE } from '../src/portal-signup/portal-signup.config';
import {
  WS, assistant, audits, body, owner, pendingRequest, rows, seed, services, staff, therapistA, withLink,
} from './support/portal-signup-fixture';

/**
 * Integración S5 (alta por QR + baja de miembro), hueco detectado por Quima: tras la baja de un
 * profesional su QR impreso no debe crear solicitudes, nadie puede rotarlo ni reactivarlo, y sus
 * solicitudes pendientes quedan solo para OWNER/ADMIN. Datos 100 % ficticios.
 */

const admin = staff('admin-1', 'ADMIN');

function seedWithAdmin() {
  const prisma = seed();
  rows(prisma, 'workspaceMember').push({ workspaceId: WS, userId: 'admin-1', role: 'ADMIN', isClinician: false, status: 'ACTIVE' });
  return prisma;
}

async function removeTherapistA(prisma: any) {
  await new MemberRemovalService(prisma).remove(WS, owner, 't-a', {} as any);
  expect(rows(prisma, 'workspaceMember').find((m: any) => m.workspaceId === WS && m.userId === 't-a').status).toBe('REMOVED');
}

describe('Baja del profesional: su QR de alta', () => {
  it('la baja apaga su QR en la misma transacción y lo audita (ids)', async () => {
    const prisma = seedWithAdmin();
    await withLink(prisma, therapistA);
    const [link] = rows(prisma, 'portalIntakeLink');
    await removeTherapistA(prisma);
    expect(rows(prisma, 'portalIntakeLink')[0].isActive).toBe(false);
    const [audit] = audits(prisma, 'MEMBER_REMOVED');
    expect(audit.metadata).toMatchObject({ disabledIntakeLinkIds: [link.id], keptSignupRequests: 0 });
  });

  it('tras la baja el QR impreso no crea solicitudes (0 filas) y responde igual que siempre', async () => {
    const prisma = seedWithAdmin();
    const token = await withLink(prisma, therapistA);
    await removeTherapistA(prisma);
    expect(await services(prisma).requests.submit(body(token) as any)).toEqual(SIGNUP_ACCEPTED_RESPONSE);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(0);
  });

  it('aunque el QR siguiera activo (dato antiguo), un profesional REMOVED no recibe solicitudes', async () => {
    const prisma = seedWithAdmin();
    const token = await withLink(prisma, therapistA);
    rows(prisma, 'workspaceMember').find((m: any) => m.userId === 't-a').status = 'REMOVED';
    expect(rows(prisma, 'portalIntakeLink')[0].isActive).toBe(true);
    expect(await services(prisma).requests.submit(body(token) as any)).toEqual(SIGNUP_ACCEPTED_RESPONSE);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(0);
  });

  it('un OWNER/ADMIN no puede ver, rotar ni reactivar el QR del dado de baja (404)', async () => {
    const prisma = seedWithAdmin();
    await withLink(prisma, therapistA);
    await removeTherapistA(prisma);
    const { links } = services(prisma);
    for (const who of [owner, admin]) {
      await expect(links.rotate(WS, who, 't-a')).rejects.toBeInstanceOf(NotFoundException);
      await expect(links.get(WS, who, 't-a')).rejects.toBeInstanceOf(NotFoundException);
      await expect(links.disable(WS, who, 't-a')).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(rows(prisma, 'portalIntakeLink')[0].isActive).toBe(false);
  });
});

describe('Baja del profesional: sus solicitudes pendientes', () => {
  it('no se borran: solo OWNER/ADMIN las ven (marcadas) y las resuelven; ASSISTANT no', async () => {
    const prisma = seedWithAdmin();
    const { requestId } = await pendingRequest(prisma, therapistA);
    await removeTherapistA(prisma);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
    expect(audits(prisma, 'MEMBER_REMOVED')[0].metadata.keptSignupRequests).toBe(1);

    const { requests } = services(prisma);
    expect((await requests.list(WS, owner)).map((r: any) => [r.id, r.professionalRemoved])).toEqual([[requestId, true]]);
    expect(await requests.list(WS, admin)).toHaveLength(1);
    expect(await requests.list(WS, assistant)).toHaveLength(0);
    await expect(requests.reject(WS, assistant, requestId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(requests.acceptCreatingPatient(WS, assistant, requestId)).rejects.toBeInstanceOf(NotFoundException);
    expect(await requests.rejectMany(WS, assistant, { requestIds: [requestId] })).toEqual({ rejected: 0, notFound: 1 });
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);

    // OWNER la acepta (creando paciente; la asignación de terapeuta se hace después abriendo el proceso).
    const accepted = await requests.acceptCreatingPatient(WS, owner, requestId);
    expect(accepted.portalAccountId).toBeDefined();
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(0);
    expect(rows(prisma, 'clinicalProcess').filter((p: any) => p.patientId === accepted.patientId)).toHaveLength(0);
  });

  it('ADMIN puede rechazarlas y siguen sujetas a la purga de 14 días', async () => {
    const prisma = seedWithAdmin();
    const first = await pendingRequest(prisma, therapistA);
    await services(prisma).requests.submit(body(first.token, { email: 'segunda@example.com' }) as any);
    await removeTherapistA(prisma);
    await services(prisma).requests.reject(WS, admin, first.requestId);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(1);
    rows(prisma, 'portalSignupRequest')[0].expiresAt = new Date(Date.now() - 1000);
    expect(await services(prisma).requests.list(WS, owner)).toHaveLength(0);
    expect(rows(prisma, 'portalSignupRequest')).toHaveLength(0);
    expect(audits(prisma, 'PORTAL_SIGNUP_REQUEST_EXPIRED')).toHaveLength(1);
  });
});
