import { PrismaClient } from '@prisma/client';
import { PortalBookingService, PortalUser } from '../src/scheduling/portal-booking.service';
import { AppointmentRequestsService } from '../src/scheduling/appointment-requests.service';
import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';
import { SessionsService } from '../src/sessions/sessions.service';

/**
 * Doble reserva contra PostgreSQL REAL (advisory locks e índice único de verdad). Criterio 14 de
 * docs/producto/reserva-citas-portal.md y corrección del assertNoOverlap no atómico de la agenda.
 *
 * Igual que session-close-race: solo se ejecuta con RACE_DATABASE_URL apuntando a una base de datos
 * DESECHABLE ya migrada; con RACE_DATABASE_REQUIRED=1 (job postgres-integration del CI) su ausencia
 * hace fallar la suite. Escribe datos ficticios y no los borra.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de doble reserva no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

const statusOf = (result: PromiseSettledResult<unknown>) => (result.status === 'rejected' ? (result.reason as any)?.getStatus?.() ?? String(result.reason) : 'ok');

describeDb('Doble reserva (PostgreSQL real)', () => {
  let prisma: PrismaClient;
  const run = `booking-race-${Date.now()}`;
  let workspaceId: string;
  let therapistId: string;
  const patients: { id: string; processId: string; account: string }[] = [];
  const therapist = () => ({ sub: therapistId, workspaceId, role: 'THERAPIST', email: `${run}@example.com` }) as any;
  const portal = (i: number): PortalUser => ({ workspaceId, patientId: patients[i].id, portalAccountId: patients[i].account, accessorType: 'PATIENT' });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const workspace = await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}` } });
    const user = await prisma.user.create({ data: { email: `${run}@example.com`, passwordHash: 'hash-ficticio', firstName: 'Profesional', lastName: 'Ficticio' } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'THERAPIST', isClinician: true } });
    workspaceId = workspace.id; therapistId = user.id;
    for (let i = 0; i < 6; i += 1) {
      const patient = await prisma.patient.create({ data: { workspaceId, firstName: 'Paciente', lastName: `Ficticio ${i}` } });
      const process = await prisma.clinicalProcess.create({ data: { workspaceId, patientId: patient.id, therapistId, title: 'Proceso ficticio' } });
      patients.push({ id: patient.id, processId: process.id, account: `${run}-acc-${i}` });
    }
    await prisma.therapistAvailability.create({ data: { workspaceId, therapistId, portalBookingEnabled: true, minNoticeHours: 2, maxHorizonDays: 60, maxPendingPerPatient: 3 } });
    await prisma.availabilityWindow.createMany({ data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ workspaceId, therapistId, weekday, startMinute: 480, endMinute: 1200 })) });
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  async function slots() {
    return (await new PortalBookingService(prisma as any).slots(portal(0), { therapistId })).slots;
  }

  it('seis pacientes piden el mismo hueco a la vez: solo uno prospera, el resto 409', async () => {
    const all = await slots();
    for (let round = 0; round < 5; round += 1) {
      const slot = all[round * 3];
      const results = await Promise.allSettled(patients.map((_, i) => new PortalBookingService(prisma as any).createRequest(portal(i), { therapistId, startsAt: slot.startsAt.toISOString() })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected').map(statusOf)).toEqual(Array(5).fill(409));
      expect(await prisma.appointmentRequest.count({ where: { workspaceId, startsAt: slot.startsAt, status: 'PENDING' } })).toBe(1);
    }
  });

  it('un paciente y una alta desde la agenda a la vez sobre el mismo hueco: solo una prospera', async () => {
    const all = await slots();
    const sessions = new SessionsService(prisma as any);
    for (let round = 0; round < 5; round += 1) {
      const slot = all[40 + round * 3];
      const results = await Promise.allSettled([
        new PortalBookingService(prisma as any).createRequest(portal(1), { therapistId, startsAt: slot.startsAt.toISOString() }),
        sessions.create(workspaceId, therapist(), { patientId: patients[2].id, clinicalProcessId: patients[2].processId, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString() } as any),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const busy = (await prisma.session.count({ where: { workspaceId, startsAt: { lt: slot.endsAt }, endsAt: { gt: slot.startsAt }, status: { not: 'CANCELLED' } } }))
        + (await prisma.appointmentRequest.count({ where: { workspaceId, status: 'PENDING', startsAt: { lt: slot.endsAt }, endsAt: { gt: slot.startsAt } } }));
      expect(busy).toBe(1);
      // Se retira la solicitud ganadora para no agotar el máximo de pendientes del paciente.
      await prisma.appointmentRequest.updateMany({ where: { workspaceId, patientId: patients[1].id, status: 'PENDING' }, data: { status: 'WITHDRAWN', heldStartsAt: null } });
    }
  });

  it('dos altas solapadas desde la agenda a la vez: la comprobación de solapes ya es atómica', async () => {
    const sessions = new SessionsService(prisma as any);
    for (let round = 0; round < 8; round += 1) {
      const start = Date.now() + (90 + round) * 86_400_000;
      const results = await Promise.allSettled([3, 4, 5].map((i, k) => sessions.create(workspaceId, therapist(), {
        patientId: patients[i].id, clinicalProcessId: patients[i].processId,
        startsAt: new Date(start + k * 600_000).toISOString(), endsAt: new Date(start + k * 600_000 + 3_000_000).toISOString(),
      } as any)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected').map(statusOf)).toEqual([400, 400]);
    }
  });

  it('aprobar dos solicitudes de huecos que se pisan (cambió la rejilla) a la vez: solo se crea una cita', async () => {
    const all = await slots();
    const slot = all[70];
    // Solicitudes insertadas a mano en huecos que se solapan (como si la duración hubiera cambiado).
    const make = (i: number, offsetMin: number) => prisma.appointmentRequest.create({
      data: {
        workspaceId, patientId: patients[i].id, therapistId, clinicalProcessId: patients[i].processId, type: 'NEW', status: 'PENDING',
        startsAt: new Date(slot.startsAt.getTime() + offsetMin * 60_000), endsAt: new Date(slot.endsAt.getTime() + offsetMin * 60_000),
        heldStartsAt: new Date(slot.startsAt.getTime() + offsetMin * 60_000), requestedByAccountId: patients[i].account, accessorType: 'PATIENT',
        expiresAt: new Date(slot.startsAt.getTime() - 3_600_000),
      },
    });
    const [a, b] = [await make(3, 0), await make(4, 20)];
    const service = new AppointmentRequestsService(prisma as any);
    const results = await Promise.allSettled([service.approve(therapist(), a.id), service.approve(therapist(), b.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map(statusOf)).toEqual([409]);
  });

  it('el índice único impide dos solicitudes PENDING del mismo hueco aunque se salte el servicio', async () => {
    const start = new Date(Date.now() + 200 * 86_400_000);
    const data = (i: number) => ({
      workspaceId, patientId: patients[i].id, therapistId, type: 'NEW' as const, status: 'PENDING' as const, startsAt: start, endsAt: new Date(start.getTime() + 3_000_000),
      heldStartsAt: start, requestedByAccountId: patients[i].account, accessorType: 'PATIENT' as const, expiresAt: start,
    });
    await prisma.appointmentRequest.create({ data: data(0) });
    await expect(prisma.appointmentRequest.create({ data: data(1) })).rejects.toMatchObject({ code: 'P2002' });
    // Resueltas (heldStartsAt nulo) no chocan entre sí.
    await prisma.appointmentRequest.create({ data: { ...data(2), status: 'WITHDRAWN', heldStartsAt: null } });
    await prisma.appointmentRequest.create({ data: { ...data(3), status: 'EXPIRED', heldStartsAt: null } });
    // Una fila resuelta que retenga hueco viola el CHECK.
    await expect(prisma.appointmentRequest.create({ data: { ...data(4), status: 'REJECTED', heldStartsAt: new Date(start.getTime() + 1) } })).rejects.toThrow();
  });
  it('cerrar un proceso a la vez que llega una solicitud, con una pendiente caducada de otro paciente: sin interbloqueos ni 500', async () => {
    const all = await slots();
    const mk = async (label: string) => {
      const patient = await prisma.patient.create({ data: { workspaceId, firstName: 'Paciente', lastName: `Ficticio ${label}` } });
      const process = await prisma.clinicalProcess.create({ data: { workspaceId, patientId: patient.id, therapistId, title: 'Proceso ficticio' } });
      return { id: patient.id, processId: process.id, account: `${run}-acc-${label}` };
    };
    const other = await mk('caducada');
    for (let round = 0; round < 10; round += 1) {
      const subject = await mk(`cierre-${round}`);
      const old = new Date(Date.now() + (300 + round) * 86_400_000);
      // Pendiente ya caducada: la creación y la aprobación la cierran de forma perezosa (expireDueRequests).
      await prisma.appointmentRequest.create({
        data: {
          workspaceId, patientId: other.id, therapistId, clinicalProcessId: other.processId, type: 'NEW', status: 'PENDING',
          startsAt: old, endsAt: new Date(old.getTime() + 3_000_000), heldStartsAt: old, requestedByAccountId: other.account,
          accessorType: 'PATIENT', expiresAt: new Date(Date.now() - 60_000),
        },
      });
      const slot = all[100 + round * 2];
      const user: PortalUser = { workspaceId, patientId: subject.id, portalAccountId: subject.account, accessorType: 'PATIENT' };
      const results = await Promise.allSettled([
        new PortalBookingService(prisma as any).createRequest(user, { therapistId, startsAt: slot.startsAt.toISOString() }),
        new ClinicalProcessesService(prisma as any).changeStatus(workspaceId, therapist(), subject.processId, 'CLOSED', { cancelFutureSessions: true }),
      ]);
      // El cierre siempre prospera; la solicitud o entra (y el cierre la rechaza) o se corta con 404/409.
      expect(results[1].status).toBe('fulfilled');
      expect([ 'ok', 404, 409 ]).toContain(statusOf(results[0]));
      expect(await prisma.appointmentRequest.count({ where: { workspaceId, patientId: subject.id, status: 'PENDING' } })).toBe(0);
    }
  });
});
