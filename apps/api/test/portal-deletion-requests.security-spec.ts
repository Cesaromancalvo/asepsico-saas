import { PortalService } from '../src/portal/portal.service';
import { NotificationsService } from '../src/notifications/notifications.service';

// Datos 100 % ficticios.
type Row = Record<string, any>;

/**
 * Almacén en memoria compartido por PortalService y NotificationsService, para comprobar de
 * extremo a extremo que la solicitud de baja llega a la bandeja real de los profesionales.
 */
function prismaMock(seed: Record<string, Row[]> = {}) {
  let stores: Record<string, Row[]> = {
    workspaceMember: [
      { workspaceId: 'ws-1', userId: 'owner-1', role: 'OWNER' },
      { workspaceId: 'ws-1', userId: 'admin-1', role: 'ADMIN' },
      { workspaceId: 'ws-1', userId: 'assistant-1', role: 'ASSISTANT' },
      { workspaceId: 'ws-1', userId: 'therapist-1', role: 'THERAPIST' },
      { workspaceId: 'ws-1', userId: 'therapist-2', role: 'THERAPIST' },
      { workspaceId: 'ws-2', userId: 'owner-ws2', role: 'OWNER' },
    ],
    clinicalProcess: [
      { workspaceId: 'ws-1', patientId: 'patient-1', therapistId: 'therapist-1', status: 'ACTIVE' },
      { workspaceId: 'ws-1', patientId: 'patient-1', therapistId: 'therapist-2', status: 'CLOSED' },
      { workspaceId: 'ws-2', patientId: 'patient-ws2', therapistId: 'therapist-9', status: 'ACTIVE' },
    ],
    notification: [],
    auditLog: [],
    ...seed,
  };
  const clone = () => Object.fromEntries(Object.entries(stores).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const matchValue = (value: any, filter: any) => {
    if (filter === null || typeof filter !== 'object') return value === filter;
    if ('in' in filter) return filter.in.includes(value);
    if ('not' in filter) return value !== filter.not;
    return true;
  };
  const matches = (row: Row, where: any = {}) => Object.entries(where).every(([k, f]) => matchValue(row[k], f));
  let seq = 0;
  const model = (name: string) => ({
    findMany: jest.fn(async ({ where }: any = {}) => stores[name].filter((r) => matches(r, where)).map((r) => ({ ...r }))),
    create: jest.fn(async ({ data }: any) => {
      if (name === 'notification' && stores.notification.some((n) => n.dedupeKey === data.dedupeKey)) {
        throw new Error('Unique constraint failed on dedupeKey');
      }
      const row = { id: `${name}-${++seq}`, createdAt: new Date(), ...data };
      stores[name].push(row);
      return { ...row };
    }),
  });
  const prisma: any = {};
  for (const name of Object.keys(stores)) prisma[name] = model(name);
  prisma.__rows = (name: string) => stores[name];
  prisma.$transaction = jest.fn(async (cb: any) => {
    const snapshot = clone();
    try {
      return await cb(prisma);
    } catch (error) {
      stores = snapshot;
      throw error;
    }
  });
  return prisma;
}

const portal = { portalAccountId: 'pa-1', patientId: 'patient-1', workspaceId: 'ws-1', accessorType: 'PATIENT' };
const staff = (sub: string, role: string, workspaceId = 'ws-1') => ({ sub, role, workspaceId });
const REASON = 'Motivo ficticio con dato de salud: tratamiento por ansiedad';

describe('Portal: solicitud de baja/borrado (art. 17 y 12.3 RGPD)', () => {
  it('la reciben en su bandeja los OWNER/ADMIN del workspace y el terapeuta del proceso activo', async () => {
    const prisma = prismaMock();
    await new PortalService(prisma, {} as any).requestDeletion(portal, REASON);
    const notifications = new NotificationsService(prisma);

    for (const [sub, role] of [['owner-1', 'OWNER'], ['admin-1', 'ADMIN'], ['therapist-1', 'THERAPIST']]) {
      const inbox = await notifications.listProfessional(staff(sub, role));
      expect({ sub, count: inbox.length }).toEqual({ sub, count: 1 });
      expect(inbox[0]).toEqual(expect.objectContaining({ title: 'Solicitud de baja de datos', actionUrl: '/patients/patient-1' }));
    }
  });

  it('no la reciben el asistente, terapeutas sin proceso activo ni usuarios de otro workspace', async () => {
    const prisma = prismaMock();
    await new PortalService(prisma, {} as any).requestDeletion(portal, REASON);
    const notifications = new NotificationsService(prisma);
    expect(await notifications.listProfessional(staff('assistant-1', 'ASSISTANT'))).toHaveLength(0);
    expect(await notifications.listProfessional(staff('therapist-2', 'THERAPIST'))).toHaveLength(0);
    expect(await notifications.listProfessional(staff('owner-ws2', 'OWNER', 'ws-2'))).toHaveLength(0);
    expect(prisma.__rows('notification').every((n: Row) => n.workspaceId === 'ws-1' && n.userId)).toBe(true);
    expect(prisma.__rows('notification')).toHaveLength(3);
  });

  it('el motivo (texto libre del paciente) no se persiste en claro ni en la auditoría ni en los avisos', async () => {
    const prisma = prismaMock();
    await new PortalService(prisma, {} as any).requestDeletion(portal, REASON);
    const [audit] = prisma.__rows('auditLog');
    expect(audit).toEqual(expect.objectContaining({ action: 'PORTAL_DELETION_REQUESTED', metadata: { accessorType: 'PATIENT', hasReason: true } }));
    const persisted = JSON.stringify({ audit: prisma.__rows('auditLog'), notifications: prisma.__rows('notification') });
    expect(persisted).not.toContain('Motivo ficticio');
    expect(persisted).not.toContain('ansiedad');
  });

  it('sin motivo registra hasReason: false', async () => {
    const prisma = prismaMock();
    await new PortalService(prisma, {} as any).requestDeletion(portal);
    expect(prisma.__rows('auditLog')[0].metadata).toEqual({ accessorType: 'PATIENT', hasReason: false });
  });

  it('dos solicitudes seguidas no chocan por dedupeKey', async () => {
    const prisma = prismaMock();
    const service = new PortalService(prisma, {} as any);
    await service.requestDeletion(portal);
    await service.requestDeletion(portal);
    expect(prisma.__rows('notification')).toHaveLength(6);
    expect(prisma.__rows('auditLog')).toHaveLength(2);
  });

  it('si falla la creación de un aviso, no queda ni la auditoría ni ningún otro aviso', async () => {
    const prisma = prismaMock();
    prisma.notification.create
      .mockImplementationOnce(async ({ data }: any) => { prisma.__rows('notification').push({ ...data }); return data; })
      .mockRejectedValueOnce(new Error('fallo al notificar'));
    await expect(new PortalService(prisma, {} as any).requestDeletion(portal, REASON)).rejects.toThrow('fallo al notificar');
    expect(prisma.__rows('notification')).toHaveLength(0);
    expect(prisma.__rows('auditLog')).toHaveLength(0);
  });
});
