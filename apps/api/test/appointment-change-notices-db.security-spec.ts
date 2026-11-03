import { PrismaClient } from '@prisma/client';
import { SessionsService } from '../src/sessions/sessions.service';
import { PortalBookingService } from '../src/scheduling/portal-booking.service';
import { AppointmentRequestsService } from '../src/scheduling/appointment-requests.service';
import { NotificationsService } from '../src/notifications/notifications.service';

/**
 * Avisos de cambio de cita al personal contra PostgreSQL REAL: las consultas de Prisma (metadata
 * JSON, createMany con skipDuplicates, filtros por workspaceId y userId) y la transacción.
 *
 * Como los demás *-db: solo con RACE_DATABASE_URL (BD DESECHABLE ya migrada); con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Crea su propio espacio ficticio.
 * Datos 100 % ficticios.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de avisos de cambio de cita no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describeDb('Avisos de cambio de cita al personal (PostgreSQL real)', () => {
  let prisma: PrismaClient;
  const run = `avisos-${Date.now()}`;
  const ids: Record<string, string> = {};
  const actor = (key: string, role: string, workspaceId = ids.ws) => ({ sub: ids[key], role, workspaceId, email: `${key}-${run}@example.com` }) as any;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const ws = await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}`, timeZone: 'Europe/Madrid' } });
    const ws2 = await prisma.workspace.create({ data: { name: `Otra consulta ficticia ${run}` } });
    ids.ws = ws.id; ids.ws2 = ws2.id;
    const user = async (key: string, role: string, isClinician: boolean, workspaceId = ws.id) => {
      const u = await prisma.user.create({ data: { email: `${key}-${run}@example.com`, passwordHash: 'hash-ficticio', firstName: key, lastName: 'Ficticio' } });
      await prisma.workspaceMember.create({ data: { workspaceId, userId: u.id, role: role as any, isClinician } });
      ids[key] = u.id;
    };
    await user('therapistA', 'THERAPIST', true);
    await user('therapistB', 'THERAPIST', true);
    await user('assistant', 'ASSISTANT', false);
    await user('owner', 'OWNER', false);
    await user('owner2', 'OWNER', false, ws2.id);
    const patient = await prisma.patient.create({ data: { workspaceId: ws.id, firstName: 'Paciente', lastName: 'Uno' } });
    ids.patient = patient.id;
    const process = await prisma.clinicalProcess.create({ data: { workspaceId: ws.id, patientId: patient.id, therapistId: ids.therapistA, title: 'Proceso ficticio' } });
    const start = new Date(Math.ceil((Date.now() + 10 * DAY) / HOUR) * HOUR);
    const session = await prisma.session.create({ data: { workspaceId: ws.id, patientId: patient.id, therapistId: ids.therapistA, clinicalProcessId: process.id, startsAt: start, endsAt: new Date(start.getTime() + 50 * 60_000) } });
    ids.session = session.id;
    await prisma.therapistAvailability.create({ data: { workspaceId: ws.id, therapistId: ids.therapistA, portalBookingEnabled: true, cancelNoticeHours: 24 } });
    const account = await prisma.patientPortalAccount.create({ data: { workspaceId: ws.id, patientId: patient.id, email: `paciente-${run}@example.com`, passwordHash: 'hash-ficticio' } as any });
    ids.account = account.id;
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('(3) si el aviso falla dentro de close(), se deshacen el estado de la cita y la auditoría', async () => {
    const start = new Date(Math.ceil((Date.now() + 20 * DAY) / HOUR) * HOUR);
    const process = await prisma.clinicalProcess.findFirstOrThrow({ where: { workspaceId: ids.ws, patientId: ids.patient } });
    const session = await prisma.session.create({ data: { workspaceId: ids.ws, patientId: ids.patient, therapistId: ids.therapistA, clinicalProcessId: process.id, startsAt: start, endsAt: new Date(start.getTime() + 50 * 60_000) } });
    // Cliente real con un único fallo: notification.createMany dentro de la transacción.
    const failing: any = new Proxy(prisma, {
      get(target: any, key) {
        if (key !== '$transaction') return target[key];
        return (cb: any) => target.$transaction((tx: any) => cb(new Proxy(tx, {
          get(inner: any, k) {
            if (k !== 'notification') return inner[k];
            return { ...inner.notification, createMany: async () => { throw new Error('fallo simulado del aviso'); } };
          },
        })));
      },
    });
    await expect(new SessionsService(failing).close(ids.ws, actor('assistant', 'ASSISTANT'), session.id, 'CANCELLED' as any)).rejects.toThrow('fallo simulado del aviso');
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('SCHEDULED');
    expect(await prisma.auditLog.count({ where: { workspaceId: ids.ws, entityId: session.id, action: 'SESSION_STATUS_CHANGED' } })).toBe(0);
    expect(await prisma.notification.count({ where: { workspaceId: ids.ws, dedupeKey: { startsWith: `appointment-change:session:${session.id}:` } } })).toBe(0);
    await prisma.session.delete({ where: { id: session.id } });
  });

  it('recepción mueve la cita, el paciente pide cancelar y OWNER rechaza: cada aviso a quien toca, con nombre solo al leer', async () => {
    const notifications = new NotificationsService(prisma as any);
    const target = new Date(Math.ceil((Date.now() + 12 * DAY) / HOUR) * HOUR);
    await new SessionsService(prisma as any).reschedule(ids.ws, actor('assistant', 'ASSISTANT'), ids.session, { startsAt: target.toISOString(), endsAt: new Date(target.getTime() + 50 * 60_000).toISOString() } as any);

    const portal = { portalAccountId: ids.account, patientId: ids.patient, workspaceId: ids.ws, accessorType: 'PATIENT' as const };
    const req = await new PortalBookingService(prisma as any).cancelRequest(portal, { sessionId: ids.session });
    await new AppointmentRequestsService(prisma as any).reject(actor('owner', 'OWNER'), req.id, { reason: 'CONTACT_PRACTICE' } as any);

    const rows = await prisma.notification.findMany({ where: { workspaceId: ids.ws, audience: 'PROFESSIONAL' } });
    const changes = rows.map((r) => `${(r.metadata as any)?.appointmentChange?.change}:${Object.keys(ids).find((k) => ids[k] === r.userId)}`).sort();
    expect(changes).toEqual([
      'PATIENT_REQUESTED_CANCEL:assistant', 'PATIENT_REQUESTED_CANCEL:owner', 'PATIENT_REQUESTED_CANCEL:therapistA',
      'REQUEST_REJECTED:therapistA', 'RESCHEDULED_BY_STAFF:therapistA',
    ]);
    for (const r of rows) {
      expect(`${r.title} ${r.body}`).not.toMatch(/Paciente|Uno|\d{1,2}:\d{2}/);
      expect(JSON.stringify(r.metadata)).not.toMatch(/Paciente|Uno|Proceso/);
    }
    expect(await prisma.notificationDelivery.count({ where: { notificationId: { in: rows.map((r) => r.id) } } })).toBe(0);

    const listA: any[] = await notifications.listProfessional(actor('therapistA', 'THERAPIST'));
    expect(listA.map((n) => n.body)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Se ha movido tu cita con Paciente Uno: de .+ a .+\.$/),
      expect.stringMatching(/^Paciente Uno ha pedido cancelar la cita del .+\.$/),
      expect.stringMatching(/^Se ha rechazado la solicitud de Paciente Uno de cancelar la cita del .+\.$/),
    ]));
    for (const n of listA) { expect(n).not.toHaveProperty('metadata'); expect(n).not.toHaveProperty('patientId'); }

    expect(await notifications.listProfessional(actor('therapistB', 'THERAPIST'))).toHaveLength(0);
    expect(await notifications.listProfessional(actor('owner2', 'OWNER', ids.ws2))).toHaveLength(0);
    // El mismo usuario con un token de otro espacio no ve ni marca lo de este.
    const aInWs2 = actor('therapistA', 'THERAPIST', ids.ws2);
    expect(await notifications.listProfessional(aInWs2)).toHaveLength(0);
    expect(await notifications.markAllProfessionalRead(aInWs2)).toEqual({ ok: true, updated: 0 });

    const a = actor('therapistA', 'THERAPIST');
    expect(await notifications.unreadCountProfessional(a)).toEqual({ unread: 3 });
    await notifications.markProfessionalRead(a, listA[0].id);
    expect(await notifications.unreadCountProfessional(a)).toEqual({ unread: 2 });
    expect(await notifications.markAllProfessionalRead(a)).toEqual({ ok: true, updated: 2 });
    expect(await notifications.unreadCountProfessional(a)).toEqual({ unread: 0 });
    // Los de recepción siguen sin leer: el marcado es solo del propio usuario.
    expect(await notifications.unreadCountProfessional(actor('assistant', 'ASSISTANT'))).toEqual({ unread: 1 });
  });
});
