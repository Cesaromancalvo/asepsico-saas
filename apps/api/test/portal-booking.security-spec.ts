import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { fakeClinicalDb } from './support/fake-clinical-db';
import { computeSlots } from '../src/scheduling/slot-calculator';
import { PortalBookingService, PortalUser } from '../src/scheduling/portal-booking.service';
import { AppointmentRequestsService } from '../src/scheduling/appointment-requests.service';
import { AvailabilityService } from '../src/scheduling/availability.service';
import { PortalRateLimitGuard } from '../src/scheduling/portal-rate-limit.guard';
import { SessionsService } from '../src/sessions/sessions.service';
import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';
import { PortalService } from '../src/portal/portal.service';
import { CreateAvailabilityBlockDto, PortalCreateRequestDto, RejectAppointmentRequestDto } from '../src/scheduling/dto/scheduling.dto';

/**
 * Reserva de citas desde el portal (docs/producto/reserva-citas-portal.md): un test por criterio
 * de aceptación de seguridad. Base de datos en memoria (support/fake-clinical-db.ts), que aplica
 * los where e ignora los select (peor caso: las respuestas se comprueban por su contenido real).
 * La concurrencia con PostgreSQL real está en booking-race.security-spec.ts.
 * Datos 100 % ficticios.
 */

const WS = 'ws-1';
const staff = (sub: string, role: string, workspaceId = WS) => ({ sub, role, workspaceId, email: `${sub}@example.com` }) as any;
const owner = staff('owner-1', 'OWNER');
const assistant = staff('assistant-1', 'ASSISTANT');
const therapistA = staff('t-a', 'THERAPIST');
const therapistB = staff('t-b', 'THERAPIST');
const portal = (patientId = 'p1', accessorType: 'PATIENT' | 'GUARDIAN' = 'PATIENT', portalAccountId = `acc-${patientId}`, workspaceId = WS): PortalUser =>
  ({ patientId, accessorType, portalAccountId, workspaceId });

const allWeek = (startMinute = 8 * 60, endMinute = 20 * 60) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ workspaceId: WS, therapistId: 't-a', weekday, startMinute, endMinute }));

const settings = (therapistId: string, extra: Record<string, unknown> = {}) => ({
  id: `av-${therapistId}`, workspaceId: WS, therapistId, portalBookingEnabled: true, sessionMinutes: 50, breakMinutes: 10,
  minNoticeHours: 2, maxHorizonDays: 14, cancelNoticeHours: 24, maxPendingPerPatient: 1, ...extra,
});

function seed(overrides: Record<string, any[]> = {}) {
  const prisma = fakeClinicalDb({
    workspace: [{ id: WS, timeZone: 'Europe/Madrid' }, { id: 'ws-2', timeZone: 'Europe/Madrid' }],
    user: [
      { id: 't-a', firstName: 'Ana', lastName: 'Ficticia' },
      { id: 't-b', firstName: 'Beto', lastName: 'Ficticio' },
      { id: 't-x', firstName: 'Xenia', lastName: 'Ficticia' },
    ],
    workspaceMember: [
      { workspaceId: WS, userId: 'owner-1', role: 'OWNER', isClinician: false },
      { workspaceId: WS, userId: 'assistant-1', role: 'ASSISTANT', isClinician: false },
      { workspaceId: WS, userId: 't-a', role: 'THERAPIST', isClinician: true },
      { workspaceId: WS, userId: 't-b', role: 'THERAPIST', isClinician: true },
      { workspaceId: 'ws-2', userId: 't-x', role: 'THERAPIST', isClinician: true },
    ],
    patient: [
      { id: 'p1', workspaceId: WS, firstName: 'Paciente', lastName: 'Uno', status: 'ACTIVE', deletedAt: null },
      { id: 'p2', workspaceId: WS, firstName: 'Paciente', lastName: 'Dos', status: 'ACTIVE', deletedAt: null },
      { id: 'p-x', workspaceId: 'ws-2', firstName: 'Paciente', lastName: 'Ajeno', status: 'ACTIVE', deletedAt: null },
    ],
    clinicalProcess: [
      { id: 'proc-1', workspaceId: WS, patientId: 'p1', therapistId: 't-a', status: 'ACTIVE', title: 'Proceso ficticio', consultationReason: 'MOTIVO-SECRETO', updatedAt: new Date() },
      { id: 'proc-2', workspaceId: WS, patientId: 'p2', therapistId: 't-a', status: 'ACTIVE', title: 'Proceso ficticio', consultationReason: 'MOTIVO-SECRETO', updatedAt: new Date() },
      { id: 'proc-x', workspaceId: 'ws-2', patientId: 'p-x', therapistId: 't-x', status: 'ACTIVE', title: 'Proceso ficticio', updatedAt: new Date() },
    ],
    therapistAvailability: [settings('t-a'), settings('t-b'), { ...settings('t-x'), workspaceId: 'ws-2' }],
    availabilityWindow: [...allWeek(), { workspaceId: WS, therapistId: 't-b', weekday: 1, startMinute: 480, endMinute: 1200 }, { workspaceId: 'ws-2', therapistId: 't-x', weekday: 1, startMinute: 480, endMinute: 1200 }],
    availabilityBlock: [],
    appointmentRequest: [],
    patientPortalAccount: [{ id: 'acc-p1', workspaceId: WS, patientId: 'p1', isActive: true }],
    ...overrides,
  } as any);
  prisma.therapistAvailability.upsert = jest.fn(async ({ where, create, update }: any) => {
    const key = where.workspaceId_therapistId;
    const rows = prisma.__store.therapistAvailability;
    const row = rows.find((r: any) => r.workspaceId === key.workspaceId && r.therapistId === key.therapistId);
    if (row) { Object.assign(row, update); return row; }
    const created = { ...settings(create.therapistId, { portalBookingEnabled: false }), ...create };
    rows.push(created);
    return created;
  });
  return prisma;
}

const booking = (prisma: any) => new PortalBookingService(prisma);
const requests = (prisma: any) => new AppointmentRequestsService(prisma);
const rows = (prisma: any, model: string) => prisma.__store[model] as any[];
const audits = (prisma: any, action: string) => rows(prisma, 'auditLog').filter((a) => a.action === action);
const codeOf = (error: any) => error?.getResponse?.()?.code;

async function firstSlot(prisma: any, index = 0, user = portal()) {
  const { slots } = await booking(prisma).slots(user, { therapistId: 't-a' });
  expect(slots.length).toBeGreaterThan(index);
  return slots[index];
}

// -----------------------------------------------------------------------------------------------
describe('Disponibilidad: cálculo de huecos (criterios 1–5)', () => {
  const base = { sessionMinutes: 50, breakMinutes: 10, minNoticeHours: 24, maxHorizonDays: 28, timeZone: 'Europe/Madrid', busy: [] as any[] };
  // Lunes 2 de noviembre de 2026, 08:00 en Madrid (CET, UTC+1).
  const now = new Date('2026-11-02T07:00:00Z');
  const tuesday = (day: number) => [new Date(Date.UTC(2026, 10, day, 0)), new Date(Date.UTC(2026, 10, day, 23))] as const;

  it('1: martes 09:00–14:00, 50 + 10 min → 09, 10, 11, 12 y 13 (ninguno termina después de las 14:00)', () => {
    const [from, to] = tuesday(10);
    const slots = computeSlots({ ...base, windows: [{ weekday: 2, startMinute: 540, endMinute: 840 }], now, from, to });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual(['08', '09', '10', '11', '12'].map((h) => `2026-11-10T${h}:00:00.000Z`));
    expect(slots.at(-1)!.endsAt.toISOString()).toBe('2026-11-10T12:50:00.000Z');
  });

  it('2: un bloqueo del 1 al 15 de agosto elimina todos los huecos de esas fechas', () => {
    const summerNow = new Date('2026-07-25T07:00:00Z');
    const block = { startsAt: new Date('2026-07-31T22:00:00Z'), endsAt: new Date('2026-08-15T22:00:00Z') };
    const slots = computeSlots({ ...base, maxHorizonDays: 30, windows: allWeek(), now: summerNow, busy: [block] });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.filter((s) => s.startsAt < block.endsAt && s.endsAt > block.startsAt)).toHaveLength(0);
  });

  it('3: una cita de otro paciente quita el hueco igual que un bloqueo (indistinguibles)', () => {
    const [from, to] = tuesday(10);
    const windows = [{ weekday: 2, startMinute: 540, endMinute: 840 }];
    const busy = { startsAt: new Date('2026-11-10T09:00:00Z'), endsAt: new Date('2026-11-10T09:50:00Z') };
    const bySession = computeSlots({ ...base, windows, now, from, to, busy: [busy] });
    const byBlock = computeSlots({ ...base, windows, now, from, to, busy: [{ ...busy }] });
    expect(bySession.map((s) => s.startsAt.toISOString())).not.toContain('2026-11-10T09:00:00.000Z');
    expect(bySession).toEqual(byBlock);
  });

  it('4: nada antes de la antelación mínima ni después de la máxima', () => {
    const slots = computeSlots({ ...base, windows: allWeek(), now });
    expect(slots[0].startsAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 24 * 3_600_000);
    expect(slots.at(-1)!.startsAt.getTime()).toBeLessThanOrEqual(now.getTime() + 28 * 86_400_000);
  });

  it('5: cambio de hora de octubre y de marzo → hora local correcta, sin duplicados ni huecos perdidos', () => {
    const night = [{ weekday: 7, startMinute: 0, endMinute: 240 }];
    const opts = { ...base, sessionMinutes: 60, breakMinutes: 0, minNoticeHours: 2, maxHorizonDays: 7 };
    // 25/10/2026: las 02:00 se repiten. 4 huecos locales (00, 01, 02, 03), 4 instantes distintos.
    const october = computeSlots({ ...opts, windows: night, now: new Date('2026-10-22T12:00:00Z'), from: new Date('2026-10-24T20:00:00Z'), to: new Date('2026-10-25T06:00:00Z') });
    expect(october.map((s) => s.startsAt.toISOString())).toEqual(['2026-10-24T22:00:00.000Z', '2026-10-24T23:00:00.000Z', '2026-10-25T00:00:00.000Z', '2026-10-25T02:00:00.000Z']);
    // 29/03/2026: las 02:00 no existen. Quedan 00, 01 y 03.
    const march = computeSlots({ ...opts, windows: night, now: new Date('2026-03-26T12:00:00Z'), from: new Date('2026-03-28T20:00:00Z'), to: new Date('2026-03-29T06:00:00Z') });
    expect(march.map((s) => s.startsAt.toISOString())).toEqual(['2026-03-28T23:00:00.000Z', '2026-03-29T00:00:00.000Z', '2026-03-29T01:00:00.000Z']);
    // Las 09:00 locales: 07:00Z en verano, 08:00Z en invierno.
    const nine = [{ weekday: 1, startMinute: 540, endMinute: 600 }];
    const summer = computeSlots({ ...opts, windows: nine, now: new Date('2026-10-17T12:00:00Z'), from: new Date('2026-10-19T00:00:00Z'), to: new Date('2026-10-19T23:00:00Z') });
    const winter = computeSlots({ ...opts, windows: nine, now: new Date('2026-10-24T12:00:00Z'), from: new Date('2026-10-26T00:00:00Z'), to: new Date('2026-10-26T23:00:00Z') });
    expect(summer[0].startsAt.toISOString()).toBe('2026-10-19T07:00:00.000Z');
    expect(winter[0].startsAt.toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });
});

// -----------------------------------------------------------------------------------------------
describe('Disponibilidad: quién la edita (criterios 6–8)', () => {
  const dto = { sessionMinutes: 50, breakMinutes: 10, minNoticeHours: 24, maxHorizonDays: 28, cancelNoticeHours: 24, maxPendingPerPatient: 1, windows: [{ weekday: 2, startMinute: 540, endMinute: 840 }] };

  it('6: un THERAPIST que edita la de otro → 403 auditado; ASSISTANT, OWNER y ADMIN pueden', async () => {
    const prisma = seed();
    const service = new AvailabilityService(prisma);
    await expect(service.update(therapistA, 't-b', dto)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.get(therapistA, 't-b')).rejects.toBeInstanceOf(ForbiddenException);
    expect(audits(prisma, 'AVAILABILITY_ACCESS_DENIED').map((a) => a.metadata.therapistId)).toEqual(['t-b', 't-b']);
    for (const actor of [assistant, owner, staff('admin-1', 'ADMIN')]) {
      await expect(service.update(actor, 't-b', dto)).resolves.toMatchObject({ therapistId: 't-b' });
    }
    await expect(service.update(therapistA, 't-a', dto)).resolves.toMatchObject({ therapistId: 't-a' });
    // Todas las escrituras de franjas van acotadas al workspace.
    for (const call of prisma.availabilityWindow.deleteMany.mock.calls) expect(call[0].where.workspaceId).toBe(WS);
    expect(audits(prisma, 'AVAILABILITY_UPDATED')).toHaveLength(4);
  });

  it('6b: un profesional de otro espacio o un no clínico → 404', async () => {
    const service = new AvailabilityService(seed());
    await expect(service.update(owner, 't-x', dto)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update(owner, 'assistant-1', dto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('7: ASSISTANT no activa ni desactiva la reserva online (403 auditado); el propio, OWNER y ADMIN sí', async () => {
    const prisma = seed();
    const service = new AvailabilityService(prisma);
    await expect(service.setPortalBooking(assistant, 't-a', { enabled: false })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.setPortalBooking(therapistB, 't-a', { enabled: false })).rejects.toBeInstanceOf(ForbiddenException);
    expect(audits(prisma, 'AVAILABILITY_ACCESS_DENIED')).toHaveLength(2);
    expect(rows(prisma, 'therapistAvailability').find((r) => r.therapistId === 't-a').portalBookingEnabled).toBe(true);
    await service.setPortalBooking(therapistA, 't-a', { enabled: false });
    await service.setPortalBooking(owner, 't-a', { enabled: true });
    await service.setPortalBooking(staff('admin-1', 'ADMIN'), 't-a', { enabled: false });
    expect(audits(prisma, 'PORTAL_BOOKING_DISABLED')).toHaveLength(2);
    expect(audits(prisma, 'PORTAL_BOOKING_ENABLED')).toHaveLength(1);
  });

  it('7b: activar la reserva no se puede colar por el PUT de ajustes (whitelist)', async () => {
    const { UpdateAvailabilityDto } = await import('../src/scheduling/dto/scheduling.dto');
    const errors = await validate(plainToInstance(UpdateAvailabilityDto, { ...dto, portalBookingEnabled: true }), { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.property)).toContain('portalBookingEnabled');
  });

  it('8: un bloqueo que pisa citas se guarda, avisa "Hay N citas" y no cancela nada; motivo solo de lista cerrada', async () => {
    const start = new Date(Date.now() + 3 * 86_400_000);
    const prisma = seed({ session: [
      { id: 's1', workspaceId: WS, patientId: 'p1', therapistId: 't-a', status: 'SCHEDULED', startsAt: start, endsAt: new Date(start.getTime() + 3_000_000) },
      { id: 's2', workspaceId: WS, patientId: 'p2', therapistId: 't-a', status: 'SCHEDULED', startsAt: new Date(start.getTime() + 7_200_000), endsAt: new Date(start.getTime() + 10_200_000) },
    ] });
    const result = await new AvailabilityService(prisma).createBlock(therapistA, 't-a', { startsAt: new Date(start.getTime() - 3_600_000).toISOString(), endsAt: new Date(start.getTime() + 86_400_000).toISOString(), reason: 'VACATION' });
    expect(result.overlappingSessions).toBe(2);
    expect(result.warning).toMatch(/Hay 2 cita/);
    expect(rows(prisma, 'session').every((s) => s.status === 'SCHEDULED')).toBe(true);
    expect(prisma.__locks).toEqual([`schedule:${WS}:t-a`]);
    const errors = await validate(plainToInstance(CreateAvailabilityBlockDto, { startsAt: start.toISOString(), endsAt: start.toISOString(), reason: 'Texto libre del motivo' }));
    expect(errors.map((e) => e.property)).toContain('reason');
  });
});

// -----------------------------------------------------------------------------------------------
describe('Qué ve el paciente (criterios 9–12)', () => {
  it('9: solo huecos de su terapeuta; B (sin proceso), otro espacio o id inexistente → el mismo 404', async () => {
    const prisma = seed();
    const service = booking(prisma);
    await expect(service.slots(portal(), { therapistId: 't-a' })).resolves.toMatchObject({ therapist: { id: 't-a' } });
    const messages: string[] = [];
    for (const therapistId of ['t-b', 't-x', 'no-existe']) {
      const error: any = await service.slots(portal(), { therapistId }).catch((e) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      messages.push(error.message);
      await expect(service.createRequest(portal(), { therapistId, startsAt: new Date(Date.now() + 86_400_000).toISOString() })).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(new Set(messages).size).toBe(1);
    expect(rows(prisma, 'appointmentRequest')).toHaveLength(0);
  });

  it('9b: terapeuta ajeno, desactivado, sin ser miembro o inexistente → exactamente el mismo 404 (mensaje y respuesta)', async () => {
    const prisma = seed();
    rows(prisma, 'clinicalProcess').push({ id: 'proc-b', workspaceId: WS, patientId: 'p1', therapistId: 't-b', status: 'CLOSED', title: 'Proceso ficticio', updatedAt: new Date() });
    const outcomes: string[] = [];
    // t-b: tiene (tuvo) proceso pero no está activo; t-x: de otro espacio; no-existe: inexistente.
    const disabled = seed();
    rows(disabled, 'therapistAvailability').find((r) => r.therapistId === 't-a').portalBookingEnabled = false;
    const notMember = seed();
    notMember.__store.workspaceMember = rows(notMember, 'workspaceMember').filter((m) => m.userId !== 't-a');
    const cases: [any, string][] = [[prisma, 't-b'], [prisma, 't-x'], [prisma, 'no-existe'], [disabled, 't-a'], [notMember, 't-a']];
    for (const [db, therapistId] of cases) {
      for (const call of [
        () => booking(db).slots(portal(), { therapistId }),
        () => booking(db).createRequest(portal(), { therapistId, startsAt: new Date(Date.now() + 86_400_000).toISOString() }),
      ]) {
        const error: any = await call().catch((e) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        outcomes.push(JSON.stringify(error.getResponse()));
      }
    }
    expect(new Set(outcomes).size).toBe(1);
  });

  it.each([
    ['proceso en PAUSED', (p: any) => { rows(p, 'clinicalProcess').find((r) => r.id === 'proc-1').status = 'PAUSED'; }],
    ['proceso DISCHARGED', (p: any) => { rows(p, 'clinicalProcess').find((r) => r.id === 'proc-1').status = 'DISCHARGED'; }],
    ['proceso CLOSED', (p: any) => { rows(p, 'clinicalProcess').find((r) => r.id === 'proc-1').status = 'CLOSED'; }],
    ['paciente PAUSED', (p: any) => { rows(p, 'patient').find((r) => r.id === 'p1').status = 'PAUSED'; }],
    ['paciente BLOCKED', (p: any) => { rows(p, 'patient').find((r) => r.id === 'p1').status = 'BLOCKED'; }],
    ['paciente ARCHIVED', (p: any) => { rows(p, 'patient').find((r) => r.id === 'p1').status = 'ARCHIVED'; }],
    ['reserva desactivada', (p: any) => { rows(p, 'therapistAvailability').find((r) => r.therapistId === 't-a').portalBookingEnabled = false; }],
    ['profesional que deja de ser miembro', (p: any) => { p.__store.workspaceMember = rows(p, 'workspaceMember').filter((m) => m.userId !== 't-a'); }],
  ])('10: %s → sin opción de reservar ("contacta con la consulta") y huecos 404', async (_label, mutate) => {
    const prisma = seed();
    mutate(prisma);
    const options = await booking(prisma).options(portal());
    expect(options.canBook).toBe(false);
    expect(options.therapists).toEqual([]);
    expect(options.message).toMatch(/contacta con la consulta/i);
    await expect(booking(prisma).slots(portal(), { therapistId: 't-a' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('11: la respuesta de huecos solo lleva inicio, fin y profesional (id y nombre): nada de citas, bloqueos, motivos ni estados', async () => {
    const start = new Date(Date.now() + 2 * 86_400_000);
    const prisma = seed({
      session: [{ id: 'SES-AJENA', workspaceId: WS, patientId: 'p2', therapistId: 't-a', status: 'SCHEDULED', startsAt: start, endsAt: new Date(start.getTime() + 3_000_000), notes: 'NOTA-AJENA' }],
      availabilityBlock: [{ id: 'BLK-1', workspaceId: WS, therapistId: 't-a', startsAt: new Date(start.getTime() + 86_400_000), endsAt: new Date(start.getTime() + 90_000_000), reason: 'PERSONAL' }],
    });
    const result: any = await booking(prisma).slots(portal(), { therapistId: 't-a' });
    expect(Object.keys(result).sort()).toEqual(['slots', 'therapist', 'timeZone']);
    expect(Object.keys(result.therapist).sort()).toEqual(['firstName', 'id', 'lastName']);
    for (const slot of result.slots) expect(Object.keys(slot).sort()).toEqual(['endsAt', 'startsAt']);
    const json = JSON.stringify(result);
    for (const leak of ['SES-AJENA', 'NOTA-AJENA', 'BLK-1', 'PERSONAL', 'p2', 'Dos', 'MOTIVO-SECRETO', 'SCHEDULED']) expect(json).not.toContain(leak);
  });

  it('12: una cuenta de tutor puede reservar y la auditoría guarda el tipo de acceso', async () => {
    const prisma = seed();
    const guardian = portal('p1', 'GUARDIAN', 'acc-tutor');
    const slot = await firstSlot(prisma, 0, guardian);
    const created: any = await booking(prisma).createRequest(guardian, { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    expect(created.status).toBe('PENDING');
    const stored = rows(prisma, 'appointmentRequest')[0];
    expect(stored).toMatchObject({ accessorType: 'GUARDIAN', requestedByAccountId: 'acc-tutor', patientId: 'p1', workspaceId: WS });
    expect(audits(prisma, 'APPOINTMENT_REQUEST_CREATED')[0].metadata).toMatchObject({ accessorType: 'GUARDIAN', portalAccountId: 'acc-tutor' });
  });
});

// -----------------------------------------------------------------------------------------------
describe('Solicitudes (criterios 13–22)', () => {
  it('13: pedir un hueco crea la solicitud PENDING, retiene el hueco, avisa al terapeuta y ya no se ofrece a otros', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    const stored = rows(prisma, 'appointmentRequest')[0];
    expect(stored).toMatchObject({ status: 'PENDING', type: 'NEW', therapistId: 't-a', clinicalProcessId: 'proc-1' });
    expect(stored.heldStartsAt.getTime()).toBe(slot.startsAt.getTime());
    expect(stored.expiresAt.getTime()).toBe(slot.startsAt.getTime() - 2 * 3_600_000);
    const notice = rows(prisma, 'notification').find((n) => n.audience === 'PROFESSIONAL');
    expect(notice).toMatchObject({ userId: 't-a', type: 'APPOINTMENT_REQUEST', workspaceId: WS });
    const other = await booking(prisma).slots(portal('p2', 'PATIENT', 'acc-p2'), { therapistId: 't-a' });
    expect(other.slots.map((s: any) => s.startsAt.getTime())).not.toContain(slot.startsAt.getTime());
    // Patient lock antes que el del profesional (orden fijo, sin interbloqueos).
    expect(prisma.__locks).toEqual([`booking:${WS}:p1`, `schedule:${WS}:t-a`]);
  });

  it('14: un inicio fuera de la rejilla, ya ocupado o retenido → 409 SLOT_NOT_AVAILABLE (sin escribir)', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    const offGrid = new Date(slot.startsAt.getTime() + 5 * 60_000).toISOString();
    expect(codeOf(await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: offGrid }).catch((e) => e))).toBe('SLOT_NOT_AVAILABLE');
    await booking(prisma).createRequest(portal('p2', 'PATIENT', 'acc-p2'), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    const error: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(codeOf(error)).toBe('SLOT_NOT_AVAILABLE');
    expect(rows(prisma, 'appointmentRequest')).toHaveLength(1);
  });

  it('14b: una alta desde la agenda sobre un hueco retenido → 409; las altas desde la agenda toman el lock del profesional', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    prisma.__locks.length = 0;
    const error: any = await new SessionsService(prisma).create(WS, therapistA, { patientId: 'p2', clinicalProcessId: 'proc-2', startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString() } as any).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(codeOf(error)).toBe('SLOT_NOT_AVAILABLE');
    expect(prisma.__locks).toEqual([`schedule:${WS}:t-a`]);
    expect(rows(prisma, 'session')).toHaveLength(0);
  });

  it('15: con el máximo de pendientes → 409 "Ya tienes una solicitud pendiente"', async () => {
    const prisma = seed();
    const [a, b] = [await firstSlot(prisma, 0), await firstSlot(prisma, 3)];
    await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: a.startsAt.toISOString() });
    const error: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: b.startsAt.toISOString() }).catch((e) => e);
    expect(codeOf(error)).toBe('TOO_MANY_PENDING_REQUESTS');
    expect(error.message).toBe('Ya tienes una solicitud pendiente.');
  });

  it('16: aprobar crea la Session SCHEDULED con el proceso activo en la transacción; con el proceso cerrado → 409 y nada', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    const req: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    const approved: any = await requests(prisma).approve(assistant, req.id);
    expect(approved.status).toBe('APPROVED');
    const session = rows(prisma, 'session')[0];
    expect(session).toMatchObject({ workspaceId: WS, patientId: 'p1', therapistId: 't-a', clinicalProcessId: 'proc-1', status: 'SCHEDULED' });
    expect(rows(prisma, 'appointmentRequest')[0]).toMatchObject({ sessionId: session.id, heldStartsAt: null, resolvedById: 'assistant-1' });
    expect(audits(prisma, 'SESSION_CREATED')[0].metadata).toMatchObject({ source: 'PORTAL_REQUEST' });

    const prisma2 = seed();
    const slot2 = await firstSlot(prisma2);
    const req2: any = await booking(prisma2).createRequest(portal(), { therapistId: 't-a', startsAt: slot2.startsAt.toISOString() });
    rows(prisma2, 'clinicalProcess').find((p) => p.id === 'proc-1').status = 'CLOSED';
    const error: any = await requests(prisma2).approve(therapistA, req2.id).catch((e) => e);
    expect(codeOf(error)).toBe('PROCESS_NOT_ACTIVE');
    expect(rows(prisma2, 'session')).toHaveLength(0);
    expect(rows(prisma2, 'appointmentRequest')[0].status).toBe('PENDING');
  });

  it('16b: si el hueco ya no está libre al aprobar (cita metida antes) → 409 y no se crea nada', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    const req: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    rows(prisma, 'session').push({ id: 'colada', workspaceId: WS, patientId: 'p2', therapistId: 't-a', status: 'SCHEDULED', startsAt: slot.startsAt, endsAt: slot.endsAt });
    expect(codeOf(await requests(prisma).approve(owner, req.id).catch((e) => e))).toBe('SLOT_NOT_AVAILABLE');
    expect(rows(prisma, 'session')).toHaveLength(1);
  });

  it('16c: un THERAPIST no resuelve solicitudes de otro (403 auditado); otro espacio → 404', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    const req: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    await expect(requests(prisma).approve(therapistB, req.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(requests(prisma).reject(therapistB, req.id, { reason: 'CONTACT_PRACTICE' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(audits(prisma, 'APPOINTMENT_REQUEST_ACCESS_DENIED')).toHaveLength(2);
    await expect(requests(prisma).approve(staff('owner-2', 'OWNER', 'ws-2'), req.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await requests(prisma).list(therapistB, {})).toEqual([]);
    expect(rows(prisma, 'appointmentRequest')[0].status).toBe('PENDING');
  });

  it('16d: la bandeja del personal no expone motivo de consulta, proceso ni notas', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    const list = await requests(prisma).list(assistant, {});
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('MOTIVO-SECRETO');
    expect(await requests(prisma).pendingCount(assistant)).toEqual({ pending: 1 });
  });

  it('17: rechazar con motivo de lista cerrada; el paciente lo ve y el hueco se libera', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    const req: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    await requests(prisma).reject(therapistA, req.id, { reason: 'DISCUSS_IN_SESSION' });
    const mine: any[] = await booking(prisma).listRequests(portal());
    expect(mine[0]).toMatchObject({ status: 'REJECTED', rejectionReason: 'DISCUSS_IN_SESSION' });
    const again = await booking(prisma).slots(portal('p2', 'PATIENT', 'acc-p2'), { therapistId: 't-a' });
    expect(again.slots.map((s: any) => s.startsAt.getTime())).toContain(slot.startsAt.getTime());
    const errors = await validate(plainToInstance(RejectAppointmentRequestDto, { reason: 'Texto libre' }));
    expect(errors).not.toHaveLength(0);
  });

  it('18: sin respuesta al llegar a "inicio − antelación mínima" → EXPIRED, hueco libre y el paciente lo ve', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    const req: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    rows(prisma, 'appointmentRequest')[0].expiresAt = new Date(Date.now() - 1000);
    const mine: any[] = await booking(prisma).listRequests(portal());
    expect(mine[0].status).toBe('EXPIRED');
    expect(rows(prisma, 'appointmentRequest')[0].heldStartsAt).toBeNull();
    expect(audits(prisma, 'APPOINTMENT_REQUEST_EXPIRED')[0]).toMatchObject({ actorId: null, entityId: req.id });
    expect(codeOf(await requests(prisma).approve(owner, req.id).catch((e) => e))).toBe('REQUEST_NOT_PENDING');
  });

  it('19: pedir cambio deja la cita original SCHEDULED hasta aprobar; al aprobar se mueve en una sola transacción', async () => {
    const start = new Date(Date.now() + 5 * 86_400_000);
    const prisma = seed({ session: [{ id: 'mia', workspaceId: WS, patientId: 'p1', therapistId: 't-a', clinicalProcessId: 'proc-1', status: 'SCHEDULED', startsAt: start, endsAt: new Date(start.getTime() + 3_000_000) }] });
    const slot = await firstSlot(prisma, 2);
    const req: any = await booking(prisma).rescheduleRequest(portal(), { sessionId: 'mia', startsAt: slot.startsAt.toISOString() });
    expect(rows(prisma, 'session')[0]).toMatchObject({ status: 'SCHEDULED', startsAt: start });
    expect(req.type).toBe('RESCHEDULE');
    const calls = prisma.$transaction.mock.calls.length;
    await requests(prisma).approve(therapistA, req.id);
    expect(prisma.$transaction.mock.calls.length).toBe(calls + 1);
    expect(rows(prisma, 'session')[0].startsAt.getTime()).toBe(slot.startsAt.getTime());
    expect(rows(prisma, 'session')).toHaveLength(1);
  });

  it('19b: la cita de otro paciente no se puede pedir cambiar ni cancelar (404)', async () => {
    const start = new Date(Date.now() + 5 * 86_400_000);
    const prisma = seed({ session: [{ id: 'ajena', workspaceId: WS, patientId: 'p2', therapistId: 't-a', status: 'SCHEDULED', startsAt: start, endsAt: new Date(start.getTime() + 3_000_000) }] });
    await expect(booking(prisma).cancelRequest(portal(), { sessionId: 'ajena' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(booking(prisma).rescheduleRequest(portal(), { sessionId: 'ajena', startsAt: start.toISOString() })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('20: dentro del plazo de cancelación no se puede pedir cambio ni cancelación (409); fuera, sí', async () => {
    const soon = new Date(Date.now() + 10 * 3_600_000);
    const later = new Date(Date.now() + 4 * 86_400_000);
    const prisma = seed({ session: [
      { id: 'pronto', workspaceId: WS, patientId: 'p1', therapistId: 't-a', clinicalProcessId: 'proc-1', status: 'SCHEDULED', startsAt: soon, endsAt: new Date(soon.getTime() + 3_000_000) },
      { id: 'luego', workspaceId: WS, patientId: 'p1', therapistId: 't-a', clinicalProcessId: 'proc-1', status: 'SCHEDULED', startsAt: later, endsAt: new Date(later.getTime() + 3_000_000) },
    ] });
    expect(codeOf(await booking(prisma).cancelRequest(portal(), { sessionId: 'pronto' }).catch((e) => e))).toBe('WITHIN_CANCELLATION_WINDOW');
    const options = await booking(prisma).options(portal());
    expect(options.appointments.find((a: any) => a.id === 'pronto')!.changeAllowed).toBe(false);
    expect(options.emergencyNotice).toMatch(/024/);
    const cancel: any = await booking(prisma).cancelRequest(portal(), { sessionId: 'luego' });
    expect(cancel).toMatchObject({ type: 'CANCEL', status: 'PENDING', startsAt: null });
    await requests(prisma).approve(owner, cancel.id);
    expect(rows(prisma, 'session').find((s) => s.id === 'luego').status).toBe('CANCELLED');
  });

  it('21: cerrar o dar de alta el proceso pasa sus pendientes a REJECTED ("contacta con la consulta") en la misma transacción', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    const processes = new ClinicalProcessesService(prisma);
    await processes.changeStatus(WS, therapistA, 'proc-1', 'DISCHARGED');
    expect(rows(prisma, 'appointmentRequest')[0]).toMatchObject({ status: 'REJECTED', rejectionReason: 'CONTACT_PRACTICE', heldStartsAt: null });
    expect(audits(prisma, 'APPOINTMENT_REQUEST_REJECTED')[0].metadata).toMatchObject({ cause: 'CLINICAL_PROCESS_DISCHARGED' });
  });

  it('21b: si la auditoría del cierre falla, la solicitud sigue PENDING (misma transacción)', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    const original = prisma.auditLog.create;
    prisma.auditLog.create = jest.fn(async (args: any) => { if (args.data.action === 'CLINICAL_PROCESS_STATUS_CHANGED') throw new Error('auditoría caída'); return original(args); });
    await expect(new ClinicalProcessesService(prisma).changeStatus(WS, therapistA, 'proc-1', 'CLOSED')).rejects.toThrow('auditoría caída');
    expect(rows(prisma, 'appointmentRequest')[0].status).toBe('PENDING');
  });

  it('22: desactivar el portal del paciente retira sus solicitudes pendientes', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    await new PortalService(prisma, {} as any).disable(WS, assistant, 'p1');
    expect(rows(prisma, 'appointmentRequest')[0]).toMatchObject({ status: 'WITHDRAWN', heldStartsAt: null });
    expect(audits(prisma, 'APPOINTMENT_REQUEST_WITHDRAWN')[0].metadata).toMatchObject({ cause: 'PORTAL_ACCOUNT_DISABLED' });
  });

  it('22b: el paciente retira la suya; la de otro paciente → 404', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    const req: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    await expect(booking(prisma).withdraw(portal('p2', 'PATIENT', 'acc-p2'), req.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(booking(prisma).withdraw(portal('p1', 'PATIENT', 'acc-p1', 'ws-2'), req.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await booking(prisma).withdraw(portal(), req.id)).status).toBe('WITHDRAWN');
  });
});

// -----------------------------------------------------------------------------------------------
describe('Seguridad, auditoría y límites (criterios 23–26)', () => {
  it('23: el patientId y el workspaceId salen de la sesión del portal; el DTO no los admite', async () => {
    const errors = await validate(plainToInstance(PortalCreateRequestDto, { therapistId: 't-a', startsAt: new Date().toISOString(), patientId: 'p2', workspaceId: 'ws-2' }), { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.property).sort()).toEqual(['patientId', 'workspaceId']);
    const prisma = seed();
    expect(await booking(prisma).listRequests(portal('p-x', 'PATIENT', 'acc-x', 'ws-2'))).toEqual([]);
    for (const call of prisma.appointmentRequest.findMany.mock.calls) expect(call[0].where.workspaceId).toBeDefined();
  });

  it('16d: al aprobar, las otras pendientes que se solapan con el hueco se rechazan (SLOT_UNAVAILABLE) con auditoría y aviso genérico', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    const req: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    const overlapping = (id: string, patientId: string, offsetMin: number) => ({
      id, workspaceId: WS, patientId, therapistId: 't-a', clinicalProcessId: 'proc-2', type: 'NEW', status: 'PENDING',
      startsAt: new Date(slot.startsAt.getTime() + offsetMin * 60_000), endsAt: new Date(slot.endsAt.getTime() + offsetMin * 60_000),
      heldStartsAt: new Date(slot.startsAt.getTime() + offsetMin * 60_000), expiresAt: new Date(Date.now() + 3_600_000),
    });
    rows(prisma, 'appointmentRequest').push(
      overlapping('solapada', 'p2', 20),
      { ...overlapping('lejana', 'p2', 24 * 60 * 3), id: 'lejana' },
    );
    await requests(prisma).approve(owner, req.id);
    const byId = (id: string) => rows(prisma, 'appointmentRequest').find((r) => r.id === id);
    expect(byId(req.id).status).toBe('APPROVED');
    expect(byId('solapada')).toMatchObject({ status: 'REJECTED', rejectionReason: 'SLOT_UNAVAILABLE', heldStartsAt: null, resolvedById: 'owner-1' });
    expect(byId('lejana').status).toBe('PENDING');
    expect(audits(prisma, 'APPOINTMENT_REQUEST_REJECTED').filter((a) => a.entityId === 'solapada')).toHaveLength(1);
    const notice = rows(prisma, 'notification').find((n) => n.dedupeKey === 'appointment-request:solapada:patient:REJECTED');
    expect(notice).toMatchObject({ audience: 'PATIENT', patientId: 'p2', body: 'Tu solicitud de cita ha sido respondida. Consúltala en tu portal.' });
    expect(`${notice.title} ${notice.body}`).not.toMatch(/Paciente|Uno|Dos|\d{1,2}:\d{2}/);
  });

  it('24: solicitud, aprobación, rechazo y retirada se auditan con ids, inicio, actor y tipo de acceso, sin texto libre', async () => {
    const prisma = seed();
    const [a, b] = [await firstSlot(prisma, 0), await firstSlot(prisma, 4)];
    const r1: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: a.startsAt.toISOString() });
    await requests(prisma).approve(therapistA, r1.id);
    const r2: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: b.startsAt.toISOString() });
    await requests(prisma).reject(owner, r2.id, { reason: 'SLOT_UNAVAILABLE' });
    const actions = rows(prisma, 'auditLog').map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['APPOINTMENT_REQUEST_CREATED', 'APPOINTMENT_REQUEST_APPROVED', 'APPOINTMENT_REQUEST_REJECTED']));
    const created = audits(prisma, 'APPOINTMENT_REQUEST_CREATED')[0];
    expect(created).toMatchObject({ workspaceId: WS, actorId: null, entityType: 'AppointmentRequest', entityId: r1.id });
    expect(created.metadata).toMatchObject({ patientId: 'p1', therapistId: 't-a', type: 'NEW', accessorType: 'PATIENT', startsAt: a.startsAt.toISOString() });
    expect(audits(prisma, 'APPOINTMENT_REQUEST_APPROVED')[0]).toMatchObject({ actorId: 't-a' });
    expect(JSON.stringify(rows(prisma, 'auditLog'))).not.toMatch(/Paciente|Uno|MOTIVO/);
  });

  it('24b: si la auditoría de la solicitud falla, no queda solicitud ni aviso', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    prisma.auditLog.create = jest.fn(async () => { throw new Error('fallo de auditoría simulado'); });
    await expect(booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() })).rejects.toThrow('fallo de auditoría simulado');
    expect(rows(prisma, 'appointmentRequest')).toHaveLength(0);
    expect(rows(prisma, 'notification')).toHaveLength(0);
  });

  it('25: huecos 30 por minuto por cuenta (31.ª → 429); otra cuenta no se ve afectada', () => {
    const reflector: any = { get: () => ({ bucket: 'slots', limit: 30, windowMs: 60_000 }) };
    const guard = new PortalRateLimitGuard(reflector);
    const ctx = (portalAccountId: string): any => ({ getHandler: () => null, switchToHttp: () => ({ getRequest: () => ({ portalUser: { portalAccountId } }) }) });
    for (let i = 0; i < 30; i += 1) expect(guard.canActivate(ctx('acc-1'))).toBe(true);
    const error: any = (() => { try { guard.canActivate(ctx('acc-1')); return null; } catch (e) { return e; } })();
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(429);
    expect(guard.canActivate(ctx('acc-2'))).toBe(true);
    expect(() => guard.canActivate({ getHandler: () => null, switchToHttp: () => ({ getRequest: () => ({}) }) } as any)).toThrow(HttpException);
  });

  it('25b: creación 5 por hora por cuenta, contado en base de datos (6.ª → 429)', async () => {
    const recent = Array.from({ length: 5 }, (_, i) => ({ id: `old-${i}`, workspaceId: WS, patientId: 'p1', therapistId: 't-a', requestedByAccountId: 'acc-p1', status: 'WITHDRAWN', createdAt: new Date(Date.now() - 60_000) }));
    const prisma = seed({ appointmentRequest: recent });
    const slot = await firstSlot(prisma);
    const error: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() }).catch((e) => e);
    expect(error.getStatus()).toBe(429);
    expect(rows(prisma, 'appointmentRequest')).toHaveLength(5);
  });

  it('26: los avisos guardados no llevan nombre del paciente ni fecha u hora de la cita', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    const req: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    await requests(prisma).reject(therapistA, req.id, { reason: 'CONTACT_PRACTICE' });
    const notices = rows(prisma, 'notification');
    expect(notices.map((n) => n.audience).sort()).toEqual(['PATIENT', 'PROFESSIONAL']);
    const iso = slot.startsAt.toISOString();
    for (const n of notices) {
      const text = `${n.title} ${n.body} ${n.actionUrl}`;
      for (const leak of ['Paciente', 'Uno', iso.slice(0, 10), iso.slice(11, 16), String(slot.startsAt.getUTCDate())]) {
        expect(text).not.toContain(leak);
      }
      expect(text).not.toMatch(/\d{1,2}:\d{2}/);
      expect(n.metadata).toBeUndefined();
    }
  });
});
