import { NotFoundException } from '@nestjs/common';
import { fakeClinicalDb } from './support/fake-clinical-db';
import { SessionsService } from '../src/sessions/sessions.service';
import { PortalBookingService, PortalUser } from '../src/scheduling/portal-booking.service';
import { AppointmentRequestsService } from '../src/scheduling/appointment-requests.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { encryptField } from '../src/common/crypto/field-encryption';
import { APPOINTMENT_CHANGES, EMAIL_FOR_CHANGE } from '../src/notifications/appointment-change-notice.util';
import { STAFF_TEMPLATES } from '../src/notifications/email/email-templates';
import { allowTestRecipientDomain, TEST_RECIPIENT_DOMAIN } from './support/test-recipient-domain';

/**
 * Avisos DENTRO de la app al personal cuando cambia una cita (decisión del Jefe 30/10):
 *  1. El profesional mueve su cita → aviso solo al paciente.
 *  2. Recepción, OWNER o ADMIN mueven (o cancelan) la cita de un profesional → aviso a ese profesional.
 *  3. El paciente pide desde el portal cambiar o cancelar → aviso al profesional y a OWNER/ADMIN/recepción.
 *  4. Otra persona aprueba o rechaza la solicitud → aviso al profesional.
 *  5. El paciente retira su petición → aviso a quienes la recibieron.
 * Seguridad: workspaceId en lectura y escritura, cada usuario solo lo suyo, un THERAPIST solo ve el
 * nombre en citas suyas, nada clínico ni en lo guardado ni en lo devuelto, nunca SMS, y el texto
 * guardado (title/body) sigue sin nombre ni fecha (criterio 26 de la reserva). Email (N1/N2,
 * 07/11/2026): solo un eco con plantilla fija de staff y solo para los cambios hechos por el paciente.
 * Datos 100 % ficticios.
 */

const WS = 'ws-1';
const WS2 = 'ws-2';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CLINICAL = ['MOTIVO-SECRETO', 'Proceso ficticio', 'NOTA-CLINICA-AVISOS', 'RESUMEN-AVISOS', 'INDIVIDUAL', 'ONLINE'];

const staff = (sub: string, role: string, workspaceId = WS) => ({ sub, role, workspaceId, email: `${sub}@example.com` }) as any;
const owner = staff('owner-1', 'OWNER');
const admin = staff('admin-1', 'ADMIN');
const assistant = staff('assistant-1', 'ASSISTANT');
const therapistA = staff('t-a', 'THERAPIST');
const therapistB = staff('t-b', 'THERAPIST');
const ownerWs2 = staff('owner-2', 'OWNER', WS2);
const portal = (patientId = 'p1'): PortalUser => ({ patientId, accessorType: 'PATIENT', portalAccountId: `acc-${patientId}`, workspaceId: WS });

// Cita de p1 con t-a a 10 días, a una hora en punto (fuera del plazo de cancelación de 24 h).
const SESSION_START = new Date(Math.ceil((Date.now() + 10 * DAY) / HOUR) * HOUR);
const plus = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

const settings = (therapistId: string, workspaceId = WS) => ({
  id: `av-${therapistId}`, workspaceId, therapistId, portalBookingEnabled: true, sessionMinutes: 50, breakMinutes: 10,
  minNoticeHours: 2, maxHorizonDays: 14, cancelNoticeHours: 24, maxPendingPerPatient: 1,
});

function seed() {
  return fakeClinicalDb({
    workspace: [{ id: WS, timeZone: 'Europe/Madrid' }, { id: WS2, timeZone: 'Europe/Madrid' }],
    // Dora R1: el email solo se encola para usuarios no demo con correo de dominio no reservado.
    // Argos C1: correos del dominio reservado de tests, permitido solo aquí (allowTestRecipientDomain).
    user: [
      { id: 't-a', firstName: 'Ana', lastName: 'Ficticia' }, { id: 't-b', firstName: 'Beto', lastName: 'Ficticio' },
      { id: 'owner-1' }, { id: 'admin-1' }, { id: 'assistant-1' }, { id: 'owner-2' }, { id: 't-x' },
    ].map((u) => ({ ...u, email: `${u.id}@${TEST_RECIPIENT_DOMAIN}`, isDemo: false })),
    workspaceMember: [
      { workspaceId: WS, userId: 'owner-1', role: 'OWNER', isClinician: false },
      { workspaceId: WS, userId: 'admin-1', role: 'ADMIN', isClinician: false },
      { workspaceId: WS, userId: 'assistant-1', role: 'ASSISTANT', isClinician: false },
      { workspaceId: WS, userId: 't-a', role: 'THERAPIST', isClinician: true },
      { workspaceId: WS, userId: 't-b', role: 'THERAPIST', isClinician: true },
      { workspaceId: WS2, userId: 'owner-2', role: 'OWNER', isClinician: false },
      { workspaceId: WS2, userId: 't-x', role: 'THERAPIST', isClinician: true },
    ],
    patient: [
      { id: 'p1', workspaceId: WS, firstName: 'Paciente', lastName: 'Uno', status: 'ACTIVE', deletedAt: null },
      { id: 'p-x', workspaceId: WS2, firstName: 'Paciente', lastName: 'Ajeno', status: 'ACTIVE', deletedAt: null },
    ],
    clinicalProcess: [
      { id: 'proc-1', workspaceId: WS, patientId: 'p1', therapistId: 't-a', status: 'ACTIVE', title: 'Proceso ficticio', consultationReason: 'MOTIVO-SECRETO', modality: 'ONLINE', updatedAt: new Date() },
    ],
    session: [{
      id: 'ses-1', workspaceId: WS, patientId: 'p1', therapistId: 't-a', clinicalProcessId: 'proc-1',
      startsAt: SESSION_START, endsAt: plus(SESSION_START, 50), status: 'SCHEDULED', type: 'INDIVIDUAL', location: null, videoCallUrl: null,
      notes: encryptField('NOTA-CLINICA-AVISOS'), internalSummary: encryptField('RESUMEN-AVISOS'), createdAt: new Date(), updatedAt: new Date(),
    }],
    therapistAvailability: [settings('t-a'), settings('t-b')],
    availabilityWindow: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ workspaceId: WS, therapistId: 't-a', weekday, startMinute: 0, endMinute: 24 * 60 })),
    availabilityBlock: [],
    appointmentRequest: [],
    patientPortalAccount: [{ id: 'acc-p1', workspaceId: WS, patientId: 'p1', isActive: true }],
    notificationDelivery: [],
  } as any);
}

const notifications = (prisma: any) => new NotificationsService(prisma);
const booking = (prisma: any) => new PortalBookingService(prisma);
const requests = (prisma: any) => new AppointmentRequestsService(prisma);
const sessions = (prisma: any) => new SessionsService(prisma);
const stored = (prisma: any) => prisma.__store.notification as any[];
const professional = (prisma: any) => stored(prisma).filter((n) => n.audience === 'PROFESSIONAL');
const recipients = (prisma: any) => professional(prisma).map((n) => n.userId).sort();

/** Lo guardado nunca lleva nombre del paciente, fecha legible ni nada clínico; no hay envíos fuera de la app. */
function expectStoredIsGeneric(prisma: any) {
  for (const n of professional(prisma)) {
    const text = `${n.title} ${n.body} ${n.actionUrl}`;
    expect(text).not.toMatch(/Paciente|Uno|\d{1,2}:\d{2}/);
    expect(JSON.stringify(n)).not.toContain('Uno');
    for (const mark of CLINICAL) expect(JSON.stringify(n)).not.toContain(mark);
    expect(n.workspaceId).toBe(WS);
    expect(n.status).toBe('SENT');
  }
  expectOnlyPatientOriginatedStaffEmails(prisma);
}

/** Entregas: solo EMAIL con plantilla de staff, del mismo espacio y para avisos originados por el paciente. */
function expectOnlyPatientOriginatedStaffEmails(prisma: any) {
  for (const d of prisma.__store.notificationDelivery ?? []) {
    expect(d.channel).toBe('EMAIL');
    expect(d.workspaceId).toBe(WS);
    expect(STAFF_TEMPLATES).toContain(d.template);
    const n = stored(prisma).find((x) => x.id === d.notificationId);
    expect(n.audience).toBe('PROFESSIONAL');
    const change = n.metadata?.appointmentChange?.change;
    expect(change === undefined || Object.keys(EMAIL_FOR_CHANGE).includes(change)).toBe(true);
  }
}

async function firstSlot(prisma: any) {
  const { slots } = await booking(prisma).slots(portal(), { therapistId: 't-a' });
  // Un hueco que no choque con la cita de la semilla.
  const free = slots.find((s: any) => s.endsAt <= SESSION_START || s.startsAt >= plus(SESSION_START, 50));
  expect(free).toBeDefined();
  return free!;
}

async function portalReschedule(prisma: any) {
  const slot = await firstSlot(prisma);
  const req: any = await booking(prisma).rescheduleRequest(portal(), { sessionId: 'ses-1', startsAt: slot.startsAt.toISOString() });
  return { req, slot };
}

const target = new Date('2027-01-12T18:30:00Z'); // martes 12 de enero, 19:30 en Madrid
const moveBody = { startsAt: target.toISOString(), endsAt: plus(target, 50).toISOString() };

// -----------------------------------------------------------------------------------------------
allowTestRecipientDomain();

describe('1–2. Mover una cita desde la agenda', () => {
  it('1: el profesional mueve su propia cita → aviso al paciente y ninguno al personal', async () => {
    const prisma = seed();
    await sessions(prisma).reschedule(WS, therapistA, 'ses-1', moveBody as any);
    expect(stored(prisma).filter((n) => n.audience === 'PATIENT')).toHaveLength(1);
    expect(professional(prisma)).toHaveLength(0);
  });

  it.each([['recepción', assistant], ['OWNER', owner], ['ADMIN', admin]])('2: %s mueve la cita de t-a → aviso solo a t-a, con nombre y fechas al leerlo', async (_label, actor) => {
    const prisma = seed();
    await sessions(prisma).reschedule(WS, actor, 'ses-1', moveBody as any);
    expect(stored(prisma).filter((n) => n.audience === 'PATIENT')).toHaveLength(1);
    expect(recipients(prisma)).toEqual(['t-a']);
    expectStoredIsGeneric(prisma);
    expect(professional(prisma)[0].metadata.appointmentChange).toMatchObject({
      change: 'RESCHEDULED_BY_STAFF', therapistId: 't-a', sessionId: 'ses-1',
      from: { startsAt: SESSION_START.toISOString() }, to: { startsAt: target.toISOString() },
    });

    const [notice]: any[] = await notifications(prisma).listProfessional(therapistA);
    expect(notice.body).toMatch(/^Se ha movido tu cita con Paciente Uno: de .+ a martes, 12 de enero, 19:30\.$/);
    expect(notice.appointmentChange).toMatchObject({ change: 'RESCHEDULED_BY_STAFF', patient: { id: 'p1', firstName: 'Paciente', lastName: 'Uno' } });
    // Quien lo movió no recibe nada.
    expect(await notifications(prisma).listProfessional(actor)).toHaveLength(0);
  });

  it('2b: recepción cancela la cita de t-a → aviso a t-a; si la cancela t-a, ninguno', async () => {
    const prisma = seed();
    await sessions(prisma).close(WS, assistant, 'ses-1', 'CANCELLED');
    expect(recipients(prisma)).toEqual(['t-a']);
    expectStoredIsGeneric(prisma);
    const [notice]: any[] = await notifications(prisma).listProfessional(therapistA);
    expect(notice.body).toMatch(/^Se ha cancelado tu cita con Paciente Uno del .+\.$/);

    const own = seed();
    await sessions(own).close(WS, therapistA, 'ses-1', 'CANCELLED');
    expect(professional(own)).toHaveLength(0);
  });

  it('2c: cerrar como realizada o ausencia no genera aviso de cambio', async () => {
    const prisma = seed();
    await sessions(prisma).close(WS, owner, 'ses-1', 'NO_SHOW');
    expect(professional(prisma)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------------------------
describe('3 y 5. El paciente pide desde el portal cambiar o cancelar', () => {
  it('3: pide cambiar → aviso a t-a y a OWNER, ADMIN y recepción del espacio; nunca a t-b ni a otro espacio', async () => {
    const prisma = seed();
    const { slot } = await portalReschedule(prisma);
    expect(recipients(prisma)).toEqual(['admin-1', 'assistant-1', 'owner-1', 't-a']);
    expectStoredIsGeneric(prisma);
    for (const n of professional(prisma)) expect(n.type).toBe('APPOINTMENT_REQUEST');

    const [notice]: any[] = await notifications(prisma).listProfessional(therapistA);
    expect(notice.body).toMatch(/^Paciente Uno ha pedido cambiar la cita del .+ al .+\.$/);
    expect(notice.appointmentChange.to.startsAt).toBe(slot.startsAt.toISOString());
    const [forAssistant]: any[] = await notifications(prisma).listProfessional(assistant);
    expect(forAssistant.body).toContain('Paciente Uno ha pedido cambiar la cita del');
    expect(await notifications(prisma).listProfessional(therapistB)).toHaveLength(0);
    expect(await notifications(prisma).listProfessional(ownerWs2)).toHaveLength(0);
  });

  it('3b: pide cancelar → «ha pedido cancelar la cita del …»', async () => {
    const prisma = seed();
    await booking(prisma).cancelRequest(portal(), { sessionId: 'ses-1' });
    expect(recipients(prisma)).toEqual(['admin-1', 'assistant-1', 'owner-1', 't-a']);
    const [notice]: any[] = await notifications(prisma).listProfessional(therapistA);
    expect(notice.body).toMatch(/^Paciente Uno ha pedido cancelar la cita del .+\.$/);
    expect(notice.appointmentChange).toMatchObject({ change: 'PATIENT_REQUESTED_CANCEL', requestType: 'CANCEL' });
  });

  it('3c (N1): una cita NUEVA pedida desde el portal → aviso genérico al profesional y a recepción (con email); OWNER/ADMIN no por defecto', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    expect(recipients(prisma)).toEqual(['assistant-1', 't-a']);
    expect(professional(prisma)[0].metadata).toBeUndefined();
    const emails = prisma.__store.notificationDelivery;
    expect(emails.map((d: any) => stored(prisma).find((n) => n.id === d.notificationId).userId).sort()).toEqual(['assistant-1', 't-a']);
    expect(emails.every((d: any) => d.template === 'STAFF_APPOINTMENT_REQUEST' && d.status === 'PENDING')).toBe(true);
    expectStoredIsGeneric(prisma);
  });

  it('Dora R1: en un espacio demo, recepción demo y terapeuta con correo reservado ven el aviso en la campana pero no se les encola email', async () => {
    const prisma = seed();
    prisma.__store.user.find((u: any) => u.id === 'assistant-1').isDemo = true;
    prisma.__store.user.find((u: any) => u.id === 't-a').email = 't-a@consulta-demo.example.test';
    const slot = await firstSlot(prisma);
    await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    expect(recipients(prisma)).toEqual(['assistant-1', 't-a']);
    expect(prisma.__store.notificationDelivery).toEqual([]);
  });

  it('3d (N1-2): un OWNER que enciende «Solicitudes de cita» recibe aviso y email; el que lo apaga (t-a) no recibe email', async () => {
    const prisma = seed();
    prisma.__store.notificationPreference.push(
      { id: 'pref-o', workspaceId: WS, userId: 'owner-1', emailAppointmentRequests: true },
      { id: 'pref-t', workspaceId: WS, userId: 't-a', emailAppointmentRequests: false },
      // Preferencia del mismo usuario en OTRO espacio: no cuenta aquí.
      { id: 'pref-x', workspaceId: WS2, userId: 'admin-1', emailAppointmentRequests: true },
    );
    const slot = await firstSlot(prisma);
    await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    expect(recipients(prisma)).toEqual(['assistant-1', 'owner-1', 't-a']);
    const emailed = prisma.__store.notificationDelivery.map((d: any) => stored(prisma).find((n) => n.id === d.notificationId).userId).sort();
    expect(emailed).toEqual(['assistant-1', 'owner-1']);
  });

  it('5b (N2): el paciente retira una solicitud NUEVA → aviso y email de cancelación a quienes la recibieron', async () => {
    const prisma = seed();
    const slot = await firstSlot(prisma);
    const req: any = await booking(prisma).createRequest(portal(), { therapistId: 't-a', startsAt: slot.startsAt.toISOString() });
    await booking(prisma).withdraw(portal(), req.id);
    const withdrawn = professional(prisma).filter((n) => n.metadata?.appointmentChange?.change === 'PATIENT_WITHDREW_REQUEST');
    expect(withdrawn.map((n) => n.userId).sort()).toEqual(['assistant-1', 't-a']);
    const cancellations = prisma.__store.notificationDelivery.filter((d: any) => d.template === 'STAFF_PATIENT_CANCELLATION');
    expect(cancellations).toHaveLength(2);
    expectStoredIsGeneric(prisma);
  });

  it('5: el paciente retira su petición → aviso a quienes la recibieron', async () => {
    const prisma = seed();
    const { req } = await portalReschedule(prisma);
    await booking(prisma).withdraw(portal(), req.id);
    const withdrawn = professional(prisma).filter((n) => n.metadata?.appointmentChange?.change === 'PATIENT_WITHDREW_REQUEST');
    expect(withdrawn.map((n) => n.userId).sort()).toEqual(['admin-1', 'assistant-1', 'owner-1', 't-a']);
    expectStoredIsGeneric(prisma);
    const list: any[] = await notifications(prisma).listProfessional(therapistA);
    expect(list.map((n) => n.body)).toContainEqual(expect.stringMatching(/^Paciente Uno ha retirado su solicitud de cambiar la cita del .+\.$/));
  });
});

// -----------------------------------------------------------------------------------------------
describe('4. Resolver una solicitud del portal', () => {
  const resultsFor = (prisma: any) => professional(prisma).filter((n) => ['REQUEST_APPROVED', 'REQUEST_REJECTED'].includes(n.metadata?.appointmentChange?.change));

  it('4: recepción aprueba el cambio → t-a recibe el resultado con la hora antigua y la nueva', async () => {
    const prisma = seed();
    const { req, slot } = await portalReschedule(prisma);
    await requests(prisma).approve(assistant, req.id);
    const results = resultsFor(prisma);
    expect(results.map((n) => n.userId)).toEqual(['t-a']);
    expect(results[0].metadata.appointmentChange).toMatchObject({
      change: 'REQUEST_APPROVED', from: { startsAt: SESSION_START.toISOString() }, to: { startsAt: slot.startsAt.toISOString() },
    });
    expectStoredIsGeneric(prisma);
    const list: any[] = await notifications(prisma).listProfessional(therapistA);
    expect(list.map((n) => n.body)).toContainEqual(expect.stringMatching(/^Se ha aprobado el cambio que pidió Paciente Uno: la cita del .+ pasa al .+\.$/));
    // El paciente sigue recibiendo su aviso genérico.
    expect(stored(prisma).filter((n) => n.audience === 'PATIENT' && n.type === 'APPOINTMENT_REQUEST_UPDATE')).toHaveLength(1);
  });

  it('4b: OWNER rechaza la cancelación → t-a recibe el resultado', async () => {
    const prisma = seed();
    const req: any = await booking(prisma).cancelRequest(portal(), { sessionId: 'ses-1' });
    await requests(prisma).reject(owner, req.id, { reason: 'CONTACT_PRACTICE' } as any);
    expect(resultsFor(prisma).map((n) => n.userId)).toEqual(['t-a']);
    const list: any[] = await notifications(prisma).listProfessional(therapistA);
    expect(list.map((n) => n.body)).toContainEqual(expect.stringMatching(/^Se ha rechazado la solicitud de Paciente Uno de cancelar la cita del .+\.$/));
  });

  it('4c: si la resuelve el propio profesional, no se le avisa', async () => {
    const prisma = seed();
    const { req } = await portalReschedule(prisma);
    await requests(prisma).approve(therapistA, req.id);
    expect(resultsFor(prisma)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------------------------
describe('Seguridad de la bandeja del personal', () => {
  it('multi-tenant: lectura, contador y marcado acotados a workspaceId y al propio usuario', async () => {
    const prisma = seed();
    await sessions(prisma).reschedule(WS, assistant, 'ses-1', moveBody as any);
    const id = professional(prisma)[0].id ?? professional(prisma)[0].dedupeKey;
    professional(prisma)[0].id = id;
    // El mismo userId con un token de otro espacio no ve ni marca nada.
    const tAOtherWs = staff('t-a', 'THERAPIST', WS2);
    expect(await notifications(prisma).listProfessional(tAOtherWs)).toHaveLength(0);
    expect(await notifications(prisma).unreadCountProfessional(tAOtherWs)).toEqual({ unread: 0 });
    await expect(notifications(prisma).markProfessionalRead(tAOtherWs, id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await notifications(prisma).markAllProfessionalRead(tAOtherWs)).toEqual({ ok: true, updated: 0 });
    expect(professional(prisma)[0].status).toBe('SENT');
    for (const call of prisma.notification.findMany.mock.calls) expect(call[0].where).toMatchObject({ audience: 'PROFESSIONAL' });
    for (const call of prisma.notification.updateMany.mock.calls) expect(call[0].where).toMatchObject({ workspaceId: WS2, userId: 't-a' });
  });

  it('el nombre del paciente se busca SIEMPRE en el espacio del lector (un patientId de otro espacio → genérico)', async () => {
    const prisma = seed();
    stored(prisma).push({
      id: 'n-cruzado', workspaceId: WS, audience: 'PROFESSIONAL', userId: 't-a', patientId: 'p-x', type: 'SYSTEM',
      title: 'Cita movida', body: 'Se ha movido una de tus citas. Consúltala en la agenda.', status: 'SENT', createdAt: new Date(),
      metadata: { appointmentChange: { change: 'RESCHEDULED_BY_STAFF', therapistId: 't-a', sessionId: 's-x', requestId: null, requestType: null, from: null, to: null } },
    });
    const [notice]: any[] = await notifications(prisma).listProfessional(therapistA);
    expect(notice.body).toBe('Se ha movido una de tus citas. Consúltala en la agenda.');
    expect(notice.appointmentChange.patient).toBeNull();
    expect(JSON.stringify(notice)).not.toContain('Ajeno');
    for (const call of prisma.patient.findMany.mock.calls) expect(call[0].where).toMatchObject({ workspaceId: WS, deletedAt: null });
  });

  it('un profesional no ve los avisos de otro, ni puede marcarlos como leídos', async () => {
    const prisma = seed();
    await sessions(prisma).reschedule(WS, owner, 'ses-1', moveBody as any);
    const notice = professional(prisma)[0];
    notice.id = 'n-ta';
    expect(await notifications(prisma).listProfessional(therapistB)).toHaveLength(0);
    await expect(notifications(prisma).markProfessionalRead(therapistB, 'n-ta')).rejects.toBeInstanceOf(NotFoundException);
    await notifications(prisma).markAllProfessionalRead(therapistB);
    expect(notice.status).toBe('SENT');
    // t-a sí lo marca.
    expect(await notifications(prisma).unreadCountProfessional(therapistA)).toEqual({ unread: 1 });
    await notifications(prisma).markProfessionalRead(therapistA, 'n-ta');
    expect(notice.status).toBe('READ');
    expect(await notifications(prisma).unreadCountProfessional(therapistA)).toEqual({ unread: 0 });
  });

  it('un THERAPIST solo ve el nombre en avisos de citas SUYAS (p. ej. un aviso que le llegó de otra cita → genérico)', async () => {
    const prisma = seed();
    stored(prisma).push({
      id: 'n-ajena', workspaceId: WS, audience: 'PROFESSIONAL', userId: 't-b', patientId: 'p1', type: 'SYSTEM',
      title: 'Cita movida', body: 'Se ha movido una de tus citas. Consúltala en la agenda.', status: 'SENT', createdAt: new Date(),
      metadata: { appointmentChange: { change: 'RESCHEDULED_BY_STAFF', therapistId: 't-a', sessionId: 'ses-1', requestId: null, requestType: null, from: { startsAt: SESSION_START.toISOString(), endsAt: SESSION_START.toISOString() }, to: null } },
    });
    const [notice]: any[] = await notifications(prisma).listProfessional(therapistB);
    expect(notice.body).toBe('Se ha movido una de tus citas. Consúltala en la agenda.');
    expect(notice.appointmentChange).toMatchObject({ patient: null, from: null, to: null, sessionId: null, requestId: null });
    expect(JSON.stringify(notice)).not.toMatch(/Paciente|Uno/);
  });

  it('recepción no ve nada clínico: solo nombre, fechas y tipo de cambio; sin metadata, patientId ni ids de proceso', async () => {
    const prisma = seed();
    await portalReschedule(prisma);
    await booking(prisma).cancelRequest(portal(), { sessionId: 'ses-1' }).catch(() => undefined);
    const list: any[] = await notifications(prisma).listProfessional(assistant);
    expect(list.length).toBeGreaterThan(0);
    for (const n of list) {
      expect(Object.keys(n).sort()).toEqual(['actionUrl', 'appointmentChange', 'body', 'createdAt', 'id', 'readAt', 'scheduledAt', 'sentAt', 'status', 'title', 'type'].sort());
      expect(Object.keys(n.appointmentChange).sort()).toEqual(['change', 'from', 'patient', 'requestId', 'requestType', 'sessionId', 'to'].sort());
      expect(Object.keys(n.appointmentChange.patient).sort()).toEqual(['firstName', 'id', 'lastName']);
      const json = JSON.stringify(n);
      for (const mark of [...CLINICAL, 'proc-1', 'therapistId', 'Ana', 'consultationReason', 'notes']) expect(json).not.toContain(mark);
    }
  });

  it('N2-2: los cambios del equipo nunca generan email al equipo; solo la petición del paciente (y nunca SMS)', async () => {
    const prisma = seed();
    const { req } = await portalReschedule(prisma);
    const afterPatient = prisma.__store.notificationDelivery.length;
    expect(afterPatient).toBeGreaterThan(0);
    await requests(prisma).approve(assistant, req.id);
    await sessions(prisma).reschedule(WS, owner, 'ses-1', moveBody as any);
    await sessions(prisma).close(WS, assistant, 'ses-1', 'CANCELLED');
    expect(professional(prisma).length).toBeGreaterThanOrEqual(6);
    expect(prisma.__store.notificationDelivery).toHaveLength(afterPatient);
    expect(prisma.__store.notificationDelivery.every((d: any) => d.channel === 'EMAIL')).toBe(true);
    expectOnlyPatientOriginatedStaffEmails(prisma);
    for (const call of prisma.notification.createMany.mock.calls) {
      for (const row of [].concat(call[0].data)) expect((row as any).workspaceId).toBe(WS);
    }
  });
});

// -----------------------------------------------------------------------------------------------
describe('Condiciones de Argos', () => {
  /** Los 7 tipos de cambio, repartidos en tres escenarios (cada uno con su base de datos). */
  async function allSevenChanges() {
    const a = seed();
    const { req: withdrawn } = await portalReschedule(a);
    await booking(a).withdraw(portal(), withdrawn.id); // PATIENT_REQUESTED_RESCHEDULE + PATIENT_WITHDREW_REQUEST
    const b = seed();
    const { req: approved } = await portalReschedule(b);
    await requests(b).approve(assistant, approved.id); // REQUEST_APPROVED
    await sessions(b).reschedule(WS, owner, 'ses-1', moveBody as any); // RESCHEDULED_BY_STAFF
    await sessions(b).close(WS, assistant, 'ses-1', 'CANCELLED'); // CANCELLED_BY_STAFF
    const c = seed();
    const cancel: any = await booking(c).cancelRequest(portal(), { sessionId: 'ses-1' }); // PATIENT_REQUESTED_CANCEL
    await requests(c).reject(owner, cancel.id, { reason: 'CONTACT_PRACTICE' } as any); // REQUEST_REJECTED
    return [a, b, c];
  }

  it('M1: solo los 3 cambios del paciente generan email (plantilla fija de staff, nunca el texto del aviso) y el texto guardado no lleva nombre, iniciales ni horas', async () => {
    const dbs = await allSevenChanges();
    const notices = dbs.flatMap((db) => professional(db).filter((n) => n.metadata?.appointmentChange));
    expect([...new Set(notices.map((n) => n.metadata.appointmentChange.change))].sort()).toEqual([...APPOINTMENT_CHANGES].sort());
    const emailedChanges = new Set<string>();
    for (const db of dbs) {
      expectOnlyPatientOriginatedStaffEmails(db);
      expect(db.notificationDelivery.create).not.toHaveBeenCalled();
      for (const d of db.__store.notificationDelivery) {
        expect(Object.keys(d)).not.toEqual(expect.arrayContaining(['title']));
        expect(JSON.stringify(d)).not.toMatch(/Paciente|Uno|body|title/);
        emailedChanges.add(stored(db).find((n: any) => n.id === d.notificationId).metadata.appointmentChange.change);
      }
    }
    expect([...emailedChanges].sort()).toEqual(Object.keys(EMAIL_FOR_CHANGE).sort());
    for (const n of notices) {
      const outbound = `${n.title}\n${n.body}`;
      expect(outbound).not.toMatch(/Paciente|Uno/);
      expect(outbound).not.toMatch(/\bP\.?\s?U\.?\b/); // iniciales
      expect(outbound).not.toMatch(/\d{1,2}:\d{2}/);
      expect(outbound).not.toMatch(/\b20\d\d\b|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre/i);
    }
  });

  it('(2) un OWNER o ASSISTANT que pasa a THERAPIST ve genéricos los avisos de citas que no son suyas', async () => {
    const prisma = seed();
    await portalReschedule(prisma); // aviso a owner-1 y assistant-1 sobre una cita de t-a
    for (const sub of ['owner-1', 'assistant-1']) {
      const before: any[] = await notifications(prisma).listProfessional(staff(sub, sub === 'owner-1' ? 'OWNER' : 'ASSISTANT'));
      expect(before[0].body).toContain('Paciente Uno');
      const after: any[] = await notifications(prisma).listProfessional(staff(sub, 'THERAPIST'));
      expect(after).toHaveLength(1);
      expect(after[0].body).toBe('Un paciente ha pedido cambiar una cita. Revísala en la agenda.');
      expect(after[0].appointmentChange).toMatchObject({ patient: null, from: null, to: null, sessionId: null, requestId: null });
      expect(JSON.stringify(after[0])).not.toMatch(/Paciente|Uno/);
    }
  });

  it('(4) GET /portal/notifications nunca devuelve avisos PROFESSIONAL, aunque lleven el patientId del paciente', async () => {
    const dbs = await allSevenChanges();
    let seen = 0;
    for (const db of dbs) {
      expect(professional(db).some((n) => n.patientId === 'p1')).toBe(true);
      db.notification.findMany.mockClear(); // solo cuentan las lecturas de GET /portal/notifications
      const list: any[] = await notifications(db).listPatient(portal());
      seen += list.length;
      for (const n of list) {
        expect(n.audience).toBe('PATIENT');
        expect(n.userId).toBeUndefined();
        expect(n.metadata?.appointmentChange).toBeUndefined();
      }
      for (const call of db.notification.findMany.mock.calls) expect(call[0].where.audience).toBe('PATIENT');
    }
    // El paciente sí ve los suyos (respuesta de solicitudes, cita movida).
    expect(seen).toBeGreaterThan(0);
  });
});
