import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PortalBookingService, PortalUser } from '../src/scheduling/portal-booking.service';
import { allowTestRecipientDomain, TEST_RECIPIENT_DOMAIN } from './support/test-recipient-domain';

/**
 * Incidente 11/11/2026 · «Enviar solicitud» desde el portal devolvía 500: el encolado de emails al
 * equipo leía NotificationPreference.emailAppointmentRequests, columna que no existía en la base
 * (P2022), DENTRO de la transacción de la solicitud. En PostgreSQL un error dentro de la transacción
 * la aborta entera, así que se perdía la solicitud y el aviso de la campana.
 *
 * Regla: un fallo al encolar emails al equipo NUNCA tumba la solicitud. La solicitud, su auditoría
 * y el aviso de la campana al profesional se guardan igualmente; solo se pierde el email.
 *
 * El fallo se simula con un error SQL REAL (columna inexistente) en la lectura de preferencias,
 * para que PostgreSQL aborte la transacción como en producción (un throw de JS no lo haría).
 *
 * Como los demás *-db: solo con RACE_DATABASE_URL (BD DESECHABLE ya migrada); con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Datos 100 % ficticios.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de fallo al encolar emails no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

describeDb('Solicitud del portal con fallo al encolar emails al equipo (PostgreSQL real)', () => {
  let prisma: PrismaClient;
  const run = `portal-email-fail-${Date.now()}`;
  const ids: Record<string, string> = {};
  let portal: PortalUser;
  allowTestRecipientDomain();

  /** Cliente real cuya lectura de preferencias falla con un error SQL de verdad dentro de la transacción. */
  function failingPrefs(): any {
    return new Proxy(prisma, {
      get(target: any, key) {
        if (key !== '$transaction') return target[key];
        return (cb: any, opts?: any) => target.$transaction((tx: any) => cb(new Proxy(tx, {
          get(inner: any, k) {
            if (k !== 'notificationPreference') return inner[k];
            return {
              ...inner.notificationPreference,
              findMany: () => inner.$queryRawUnsafe('SELECT "columnaQueNoExiste" FROM "NotificationPreference"'),
            };
          },
        })), opts);
      },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const ws = await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}`, timeZone: 'Europe/Madrid' } });
    ids.ws = ws.id;
    const user = async (key: string, role: string, isClinician: boolean) => {
      const u = await prisma.user.create({ data: { email: `${key}-${run}@${TEST_RECIPIENT_DOMAIN}`, passwordHash: 'hash-ficticio', firstName: key, lastName: 'Ficticio' } });
      await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role: role as any, isClinician } });
      ids[key] = u.id;
    };
    await user('therapist', 'THERAPIST', true);
    await user('assistant', 'ASSISTANT', false);
    await user('owner', 'OWNER', false);
    const patient = await prisma.patient.create({ data: { workspaceId: ws.id, firstName: 'Paciente', lastName: 'Inventada' } });
    await prisma.clinicalProcess.create({ data: { workspaceId: ws.id, patientId: patient.id, therapistId: ids.therapist, title: 'Proceso ficticio' } });
    await prisma.therapistAvailability.create({ data: { workspaceId: ws.id, therapistId: ids.therapist, portalBookingEnabled: true, minNoticeHours: 2, maxHorizonDays: 60, maxPendingPerPatient: 5 } });
    await prisma.availabilityWindow.createMany({ data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ workspaceId: ws.id, therapistId: ids.therapist, weekday, startMinute: 480, endMinute: 1200 })) });
    const account = await prisma.patientPortalAccount.create({ data: { workspaceId: ws.id, patientId: patient.id, email: `paciente-${run}@${TEST_RECIPIENT_DOMAIN}`, passwordHash: 'hash-ficticio' } as any });
    portal = { workspaceId: ws.id, patientId: patient.id, portalAccountId: account.id, accessorType: 'PATIENT' };
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  async function freeSlot(index: number) {
    const { slots } = await new PortalBookingService(prisma as any).slots(portal, { therapistId: ids.therapist });
    return slots[index];
  }

  const noticesOf = (requestId: string) =>
    prisma.notification.findMany({ where: { workspaceId: ids.ws, dedupeKey: { startsWith: `appointment-request:${requestId}:` } }, select: { id: true, userId: true } });

  it('control · sin fallo: aviso en la campana al profesional y a recepción, y emails encolados', async () => {
    const slot = await freeSlot(0);
    const created = await new PortalBookingService(prisma as any).createRequest(portal, { therapistId: ids.therapist, startsAt: slot.startsAt });
    const notices = await noticesOf(created.id);
    expect(new Set(notices.map((n) => n.userId))).toEqual(new Set([ids.therapist, ids.assistant]));
    const deliveries = await prisma.notificationDelivery.count({ where: { workspaceId: ids.ws, channel: 'EMAIL', notificationId: { in: notices.map((n) => n.id) } } });
    expect(deliveries).toBe(2);
  });

  it('con fallo al leer preferencias: la solicitud se guarda (no 500), con auditoría y aviso al profesional, sin email', async () => {
    const slot = await freeSlot(1);
    let created: any;
    try {
      created = await new PortalBookingService(failingPrefs()).createRequest(portal, { therapistId: ids.therapist, startsAt: slot.startsAt });
    } catch (error) {
      // Antes del arreglo: error de Prisma sin HttpException → el filtro global responde 500.
      throw new Error(`createRequest lanzó ${error instanceof HttpException ? `HTTP ${error.getStatus()}` : '500 (error no HTTP)'}: ${String((error as any)?.message).slice(0, 120)}`);
    }
    const saved = await prisma.appointmentRequest.findFirstOrThrow({ where: { id: created.id, workspaceId: ids.ws } });
    expect(saved.status).toBe('PENDING');
    expect(await prisma.auditLog.count({ where: { workspaceId: ids.ws, entityId: created.id, action: 'APPOINTMENT_REQUEST_CREATED' } })).toBe(1);
    const notices = await noticesOf(created.id);
    expect(notices.map((n) => n.userId)).toEqual([ids.therapist]);
    expect(await prisma.notificationDelivery.count({ where: { workspaceId: ids.ws, notificationId: { in: notices.map((n) => n.id) } } })).toBe(0);
  });

  it('con fallo al leer preferencias: retirar una solicitud NUEVA (aviso de cambio) tampoco da 500', async () => {
    const slot = await freeSlot(2);
    const created = await new PortalBookingService(prisma as any).createRequest(portal, { therapistId: ids.therapist, startsAt: slot.startsAt });
    const withdrawn = await new PortalBookingService(failingPrefs()).withdraw(portal, created.id);
    expect(withdrawn.status).toBe('WITHDRAWN');
    expect(await prisma.auditLog.count({ where: { workspaceId: ids.ws, entityId: created.id, action: 'APPOINTMENT_REQUEST_WITHDRAWN' } })).toBe(1);
    expect(await prisma.notification.count({ where: { workspaceId: ids.ws, dedupeKey: { startsWith: `appointment-request:${created.id}:withdrawn` } } })).toBeGreaterThan(0);
  });
});
