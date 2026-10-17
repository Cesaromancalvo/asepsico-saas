// Flujo completo de la reserva de citas del portal contra la API REAL compilada y PostgreSQL real.
// Datos 100 % ficticios. Solo para BD DESECHABLES: crea dos espacios de trabajo, sus usuarios y
// pacientes de prueba (no los borra) y activa el MFA de las cuentas que crea.
//
// Requisitos: migraciones aplicadas, `npm run build` hecho (usa apps/api/dist para registrar la
// aceptación de condiciones) y la API arrancada.
//
//   DATABASE_URL        BD de la API (obligatoria; debe ser local).
//   ASEPSICO_API_URL    URL base de la API (por defecto http://127.0.0.1:4000/api/v1; debe ser local).
//
// Cubre: activar la reserva y franjas (THERAPIST), huecos, pedir cita, cambio y cancelación desde el
// portal (cookie + CSRF), aprobar y rechazar, caducidad, retirada, cita en la agenda, aprobar con
// otra pendiente solapada (SLOT_UNAVAILABLE) y los tres controles de Argos: /scheduling/professionals
// (THERAPIST solo se ve a sí mismo, nunca otro espacio), JSON sin `email`, y /scheduling/requests sin
// claves clínicas. El script nunca imprime contraseñas, TOTP ni tokens.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const API = process.env.ASEPSICO_API_URL || 'http://127.0.0.1:4000/api/v1';
const DATABASE_URL = process.env.DATABASE_URL || '';
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (!DATABASE_URL) throw new Error('Falta DATABASE_URL (BD desechable local)');
if (!LOCAL.has(new URL(API).hostname) || !LOCAL.has(new URL(DATABASE_URL).hostname)) {
  throw new Error('Este script crea cuentas y activa MFA: solo se ejecuta contra una API y una BD locales');
}

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PrismaClient } = requireFromApi('@prisma/client');
const { hash } = requireFromApi('bcryptjs');
const { generate } = requireFromApi('otplib');
const { pendingLegalDocuments, recordTermsAcceptances } = requireFromApi('./dist/legal/terms-acceptance.js');
const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

const stamp = Date.now();
const strong = () => 'Aa1' + randomBytes(18).toString('base64url');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CONSULTATION_MARKER = 'Motivo ficticio reserva no debe salir en solicitudes';
const PROCESS_MARKER = 'Proceso ficticio reserva sin titulo en solicitudes';

let checks = 0;
function assert(value, message) { if (!value) throw new Error(`FALLO: ${message}`); checks += 1; }

// ---------- HTTP con cookies y CSRF ----------
// Cada sesión sale con su propia IP (X-Forwarded-For; la API de prueba arranca con TRUST_PROXY=loopback):
// así los límites por IP del login y del portal no se mezclan entre cuentas ni entre ejecuciones.
const runOctets = `${1 + Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}`;
let ipCounter = 0;
const newJar = () => { const jar = new Map(); jar.ip = `10.${runOctets}.${(ipCounter += 1)}`; return jar; };
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function capture(res, jar) { for (const raw of res.headers.getSetCookie?.() || []) { const [pair] = raw.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); } }
async function call(jar, path, { method = 'GET', body, csrf = true } = {}) {
  const headers = { 'x-forwarded-for': jar.ip };
  if (jar.size) headers.cookie = cookieHeader(jar);
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method) && csrf && jar.get('csrf_token')) headers['x-csrf-token'] = decodeURIComponent(jar.get('csrf_token'));
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  capture(res, jar);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}
async function ok(jar, path, options) { const r = await call(jar, path, options); if (!r.ok) throw new Error(`${options?.method ?? 'GET'} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; }

// ---------- Alta de cuentas ficticias (BD) y sesión con MFA ----------
async function createMember(workspaceId, label, role, isClinician) {
  const password = strong();
  const user = await prisma.user.create({ data: { email: `reserva-${label}-${stamp}@example.test`, passwordHash: await hash(password, 4), firstName: label.toUpperCase(), lastName: 'Ficticio' } });
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role, isClinician } });
  await prisma.$transaction(async (tx) => {
    const pending = await pendingLegalDocuments(tx, workspaceId, user.id);
    if (pending.length) await recordTermsAcceptances(tx, { workspaceId, userId: user.id, docs: pending, meta: { userAgent: 'verify-reserva-citas-live' } });
  });
  return { id: user.id, email: user.email, password, role, workspaceId, jar: newJar() };
}

async function staffLogin(member) {
  const login = await ok(member.jar, '/auth/login', { method: 'POST', body: { email: member.email, password: member.password } });
  assert(!login.mfaRequired, `${member.role} no debería tener MFA todavía`);
  if (['OWNER', 'ADMIN', 'THERAPIST'].includes(member.role)) {
    const setup = await ok(member.jar, '/auth/mfa/setup', { method: 'POST' });
    await ok(member.jar, '/auth/mfa/confirm', { method: 'POST', body: { password: member.password, code: await generate({ secret: setup.secret }) } });
    await ok(member.jar, '/auth/refresh', { method: 'POST' });
  }
  return member;
}

async function createPatient(owner, label, therapist, portalAdmin) {
  // `owner` da de alta al paciente y abre el proceso (el profesional que lo trata); el portal lo activa `portalAdmin`
  // (OWNER/ADMIN/ASSISTANT: un THERAPIST no puede) .
  const patient = await ok(owner.jar, '/patients', { method: 'POST', body: { firstName: `Paciente${label}`, lastName: 'Ficticio', email: `paciente-${label}-${stamp}@example.test`, consultationReason: CONSULTATION_MARKER, portalAccessMode: 'PATIENT_ONLY' } });
  await ok(owner.jar, '/clinical-processes', { method: 'POST', body: { patientId: patient.id, therapistId: therapist.id, title: PROCESS_MARKER } });
  const password = strong();
  const email = `portal-${label}-${stamp}@example.test`;
  const account = await ok(portalAdmin.jar, `/patients/${patient.id}/portal-account`, { method: 'POST', body: { email, temporaryPassword: password, accessorType: 'PATIENT' } });
  const jar = newJar();
  await ok(jar, '/portal/auth/login', { method: 'POST', body: { email, password } });
  assert(jar.get('portal_access_token') && jar.get('csrf_token'), 'el login del portal debe dejar cookie de sesión y de CSRF');
  return { id: patient.id, email, accountId: account.id, jar };
}

// ---------- Utilidades de comprobación ----------
function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out); }
  return out;
}
const futureSlots = (slots, minDays) => slots.filter((s) => new Date(s.startsAt).getTime() > Date.now() + minDays * DAY);
const iso = (d) => new Date(d).toISOString();

async function main() {
  console.log('0/9 Preparar dos espacios de trabajo ficticios, sus cuentas y pacientes');
  const wsA = await prisma.workspace.create({ data: { name: `Consulta ficticia A ${stamp}` } });
  const wsB = await prisma.workspace.create({ data: { name: `Consulta ficticia B ${stamp}` } });
  const owner = await createMember(wsA.id, 'owner', 'OWNER', false);
  const t1 = await createMember(wsA.id, 't1', 'THERAPIST', true);
  const t2 = await createMember(wsA.id, 't2', 'THERAPIST', true);
  const assistant = await createMember(wsA.id, 'asistente', 'ASSISTANT', false);
  const tb = await createMember(wsB.id, 'tb', 'THERAPIST', true);
  const ownerB = await createMember(wsB.id, 'ownerb', 'OWNER', false);
  for (const m of [owner, t1, t2, assistant, tb, ownerB]) await staffLogin(m);
  const p1 = await createPatient(t1, 'Uno', t1, owner);
  const p2 = await createPatient(t1, 'Dos', t1, owner);
  const p3 = await createPatient(t1, 'Tres', t1, owner);
  const p4 = await createPatient(t2, 'Cuatro', t2, owner); // paciente de OTRO terapeuta del mismo espacio

  console.log('1/9 Reserva desactivada por defecto: el paciente no ve profesionales ni huecos');
  const off = await ok(p1.jar, '/portal/booking/options');
  assert(off.canBook === false && off.therapists.length === 0, 'sin activar, canBook debe ser false');
  assert((await call(p1.jar, `/portal/booking/slots?therapistId=${t1.id}`)).status === 404, 'huecos con la reserva desactivada: 404');

  console.log('2/9 El terapeuta define sus franjas y activa la reserva; la recepción y los demás no pueden');
  const settings = { sessionMinutes: 50, breakMinutes: 10, minNoticeHours: 2, maxHorizonDays: 28, cancelNoticeHours: 24, maxPendingPerPatient: 3, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 480, endMinute: 1200 })) };
  assert((await call(t1.jar, `/scheduling/availability/${t1.id}`, { method: 'PUT', body: { ...settings, portalBookingEnabled: true } })).status === 400, 'activar la reserva por el PUT de ajustes debe rechazarse (whitelist)');
  await ok(t1.jar, `/scheduling/availability/${t1.id}`, { method: 'PUT', body: settings });
  assert((await call(assistant.jar, `/scheduling/availability/${t1.id}/portal-booking`, { method: 'PATCH', body: { enabled: true } })).status === 403, 'ASSISTANT no activa la reserva online');
  assert((await call(t2.jar, `/scheduling/availability/${t1.id}`, { method: 'PUT', body: settings })).status === 403, 'THERAPIST ajeno no edita franjas de otro');
  assert((await call(tb.jar, `/scheduling/availability/${t1.id}`)).status === 403, 'THERAPIST de otro espacio no lee la disponibilidad de T1 (403, sin datos)');
  assert((await call(ownerB.jar, `/scheduling/availability/${t1.id}`)).status === 404, 'OWNER de otro espacio: 404, ni siquiera confirma que existe');
  assert((await call(ownerB.jar, `/scheduling/availability/${t1.id}/portal-booking`, { method: 'PATCH', body: { enabled: false } })).status === 404, 'OWNER de otro espacio no desactiva la reserva de T1');
  await ok(t1.jar, `/scheduling/availability/${t1.id}/portal-booking`, { method: 'PATCH', body: { enabled: true } });
  const mine = await ok(t1.jar, `/scheduling/availability/${t1.id}`);
  assert(mine.windows.length === 7 && mine.settings.portalBookingEnabled === true, 'las franjas y la activación se guardan');

  console.log('3/9 El paciente ve huecos (solo inicio y fin) y pide cita');
  const opts = await ok(p1.jar, '/portal/booking/options');
  assert(opts.canBook === true && opts.therapists.length === 1 && opts.therapists[0].id === t1.id, 'el paciente ve solo a su terapeuta');
  const slotsRes = await ok(p1.jar, `/portal/booking/slots?therapistId=${t1.id}`);
  assert(slotsRes.slots.length > 50, `debe haber huecos (hay ${slotsRes.slots.length})`);
  for (const s of slotsRes.slots) assert(Object.keys(s).sort().join() === 'endsAt,startsAt', 'un hueco solo lleva inicio y fin');
  assert((await call(p1.jar, `/portal/booking/slots?therapistId=${t2.id}`)).status === 404, 'el terapeuta con quien no tiene proceso: 404');
  assert((await call(p1.jar, `/portal/booking/slots?therapistId=${tb.id}`)).status === 404, 'terapeuta de otro espacio: 404 igual');
  assert((await call(newJar(), `/portal/booking/slots?therapistId=${t1.id}`)).status === 401, 'sin cookie de portal: 401');
  const noCsrf = await call(p1.jar, '/portal/booking/requests', { method: 'POST', body: { therapistId: t1.id, startsAt: slotsRes.slots[0].startsAt }, csrf: false });
  assert(noCsrf.status === 403, `sin CSRF: 403 (fue ${noCsrf.status})`);
  assert((await call(p1.jar, '/portal/booking/requests', { method: 'POST', body: { therapistId: t1.id, startsAt: slotsRes.slots[0].startsAt, patientId: p2.id, workspaceId: wsB.id } })).status === 400, 'el DTO no admite patientId ni workspaceId');

  const far = futureSlots(slotsRes.slots, 3);
  const slotA = far[0]; const slotB = far[5]; const slotC = far[10]; const slotD = far[15];
  const created = await ok(p1.jar, '/portal/booking/requests', { method: 'POST', body: { therapistId: t1.id, startsAt: slotA.startsAt } });
  assert(created.status === 'PENDING' && created.type === 'NEW', 'la solicitud queda PENDING');
  const othersSlots = await ok(p2.jar, `/portal/booking/slots?therapistId=${t1.id}`);
  assert(!othersSlots.slots.some((s) => s.startsAt === slotA.startsAt), 'el hueco retenido ya no se ofrece a otros');
  assert((await call(p2.jar, '/portal/booking/requests', { method: 'POST', body: { therapistId: t1.id, startsAt: slotA.startsAt } })).status === 409, 'pedir el mismo hueco: 409');

  console.log('4/9 El terapeuta aprueba y la cita aparece en la agenda; solo el suyo');
  const pendingCount = await ok(t1.jar, '/scheduling/requests/pending-count');
  assert(pendingCount.pending === 1, `contador de pendientes = 1 (fue ${pendingCount.pending})`);
  assert((await call(t2.jar, `/scheduling/requests/${created.id}/approve`, { method: 'POST' })).status === 403, 'otro THERAPIST no aprueba solicitudes ajenas');
  assert((await call(tb.jar, `/scheduling/requests/${created.id}/approve`, { method: 'POST' })).status === 404, 'otro espacio: 404');
  const approved = await ok(t1.jar, `/scheduling/requests/${created.id}/approve`, { method: 'POST' });
  assert(approved.status === 'APPROVED' && approved.sessionId, 'aprobada con sesión creada');
  const agendaUrl = `/sessions?from=${encodeURIComponent(iso(Date.now() - DAY))}&to=${encodeURIComponent(iso(Date.now() + 40 * DAY))}`;
  const agendaRows = async () => { const r = await ok(t1.jar, agendaUrl); return r.data ?? r; };
  const inAgenda = (await agendaRows()).find((s) => s.id === approved.sessionId);
  assert(inAgenda && inAgenda.status === 'SCHEDULED' && iso(inAgenda.startsAt) === iso(slotA.startsAt), 'la cita aparece en la agenda en su hora');
  assert((await call(p1.jar, `/portal/booking/requests/${created.id}/withdraw`, { method: 'POST' })).status === 404, 'una solicitud ya resuelta no se retira');

  console.log('5/9 Cambio de cita: pendiente hasta aprobar; rechazo deja la cita; cancelación aprobada la cancela');
  const o2 = await ok(p1.jar, '/portal/booking/options');
  const appt = o2.appointments.find((a) => a.id === approved.sessionId);
  assert(appt && appt.changeAllowed === true, 'la cita es modificable (fuera del plazo de cancelación)');
  const resched = await ok(p1.jar, '/portal/booking/requests/reschedule', { method: 'POST', body: { sessionId: approved.sessionId, startsAt: slotB.startsAt } });
  assert(resched.status === 'PENDING' && resched.type === 'RESCHEDULE', 'cambio PENDING');
  assert(iso((await agendaRows()).find((s) => s.id === approved.sessionId).startsAt) === iso(slotA.startsAt), 'la cita original no se mueve hasta aprobar');
  assert((await call(p1.jar, '/portal/booking/requests/reschedule', { method: 'POST', body: { sessionId: approved.sessionId, startsAt: slotC.startsAt } })).status === 409, 'otro cambio sobre la misma cita pendiente: 409');
  assert((await ok(t1.jar, `/scheduling/requests/${resched.id}/approve`, { method: 'POST' })).status === 'APPROVED', 'cambio aprobado');
  const moved = (await agendaRows()).find((s) => s.id === approved.sessionId);
  assert(iso(moved.startsAt) === iso(slotB.startsAt) && moved.status === 'SCHEDULED', 'la cita se movió al hueco nuevo');
  assert((await call(p3.jar, '/portal/booking/requests/cancel', { method: 'POST', body: { sessionId: approved.sessionId } })).status === 404, 'cancelar la cita de otro paciente: 404');
  const cancel1 = await ok(p1.jar, '/portal/booking/requests/cancel', { method: 'POST', body: { sessionId: approved.sessionId } });
  const rejected = await ok(t1.jar, `/scheduling/requests/${cancel1.id}/reject`, { method: 'POST', body: { reason: 'DISCUSS_IN_SESSION' } });
  assert(rejected.status === 'REJECTED' && rejected.rejectionReason === 'DISCUSS_IN_SESSION', 'rechazo con motivo de lista cerrada');
  assert((await call(t1.jar, `/scheduling/requests/${cancel1.id}/reject`, { method: 'POST', body: { reason: 'texto libre' } })).status === 400, 'motivo fuera de la lista: 400');
  const seen = (await ok(p1.jar, '/portal/booking/requests')).find((r) => r.id === cancel1.id);
  assert(seen.status === 'REJECTED' && seen.rejectionReason === 'DISCUSS_IN_SESSION', 'el paciente ve el rechazo y su motivo');
  assert((await prisma.session.findUnique({ where: { id: approved.sessionId } })).status === 'SCHEDULED', 'tras rechazar la cancelación, la cita sigue programada');
  const cancel2 = await ok(p1.jar, '/portal/booking/requests/cancel', { method: 'POST', body: { sessionId: approved.sessionId } });
  await ok(t1.jar, `/scheduling/requests/${cancel2.id}/approve`, { method: 'POST' });
  assert((await prisma.session.findUnique({ where: { id: approved.sessionId } })).status === 'CANCELLED', 'cancelación aprobada: la cita queda CANCELLED');

  console.log('6/9 Caducidad y retirada');
  const toExpire = await ok(p3.jar, '/portal/booking/requests', { method: 'POST', body: { therapistId: t1.id, startsAt: slotC.startsAt } });
  // La caducidad real es "inicio - antelación mínima"; aquí se adelanta el plazo para no esperar.
  await prisma.appointmentRequest.update({ where: { id: toExpire.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  const listed = (await ok(p3.jar, '/portal/booking/requests')).find((r) => r.id === toExpire.id);
  assert(listed.status === 'EXPIRED', `la solicitud pasada de plazo caduca al consultarla (fue ${listed.status})`);
  assert((await prisma.appointmentRequest.findUnique({ where: { id: toExpire.id } })).heldStartsAt === null, 'caducada libera el hueco retenido');
  assert((await ok(p3.jar, `/portal/booking/slots?therapistId=${t1.id}`)).slots.some((s) => s.startsAt === slotC.startsAt), 'el hueco caducado vuelve a ofrecerse');
  assert((await call(t1.jar, `/scheduling/requests/${toExpire.id}/approve`, { method: 'POST' })).status === 409, 'aprobar una caducada: 409');
  assert(await prisma.auditLog.count({ where: { workspaceId: wsA.id, action: 'APPOINTMENT_REQUEST_EXPIRED', entityId: toExpire.id } }) === 1, 'la caducidad queda auditada una vez');
  const toWithdraw = await ok(p3.jar, '/portal/booking/requests', { method: 'POST', body: { therapistId: t1.id, startsAt: slotD.startsAt } });
  assert((await call(p2.jar, `/portal/booking/requests/${toWithdraw.id}/withdraw`, { method: 'POST' })).status === 404, 'retirar la solicitud de otro paciente: 404');
  assert((await ok(p3.jar, `/portal/booking/requests/${toWithdraw.id}/withdraw`, { method: 'POST' })).status === 'WITHDRAWN', 'el paciente retira la suya');

  console.log('7/9 Aprobar con otra pendiente solapada: la segunda se rechaza con SLOT_UNAVAILABLE');
  const slotE = far[20];
  const first = await ok(p3.jar, '/portal/booking/requests', { method: 'POST', body: { therapistId: t1.id, startsAt: slotE.startsAt } });
  const process2 = await prisma.clinicalProcess.findFirst({ where: { workspaceId: wsA.id, patientId: p2.id } });
  const shift = 20 * 60_000; // como si la rejilla hubiera cambiado: hueco que pisa al anterior
  const overlapping = await prisma.appointmentRequest.create({
    data: {
      workspaceId: wsA.id, patientId: p2.id, therapistId: t1.id, clinicalProcessId: process2.id, type: 'NEW', status: 'PENDING',
      startsAt: new Date(new Date(slotE.startsAt).getTime() + shift), endsAt: new Date(new Date(slotE.endsAt).getTime() + shift),
      heldStartsAt: new Date(new Date(slotE.startsAt).getTime() + shift), requestedByAccountId: p2.accountId, accessorType: 'PATIENT',
      expiresAt: new Date(new Date(slotE.startsAt).getTime() - 3 * HOUR),
    },
  });
  await ok(t1.jar, `/scheduling/requests/${first.id}/approve`, { method: 'POST' });
  const after = await prisma.appointmentRequest.findUnique({ where: { id: overlapping.id } });
  assert(after.status === 'REJECTED' && after.rejectionReason === 'SLOT_UNAVAILABLE' && after.heldStartsAt === null, `la solapada queda REJECTED/SLOT_UNAVAILABLE (fue ${after.status}/${after.rejectionReason})`);
  const p2sees = (await ok(p2.jar, '/portal/booking/requests')).find((r) => r.id === overlapping.id);
  assert(p2sees.status === 'REJECTED' && p2sees.rejectionReason === 'SLOT_UNAVAILABLE', 'el paciente de la solapada lo ve');
  assert(await prisma.auditLog.count({ where: { workspaceId: wsA.id, action: 'APPOINTMENT_REQUEST_REJECTED', entityId: overlapping.id } }) === 1, 'el rechazo automático se audita');
  const notice = await prisma.notification.findFirst({ where: { workspaceId: wsA.id, patientId: p2.id, type: 'APPOINTMENT_REQUEST_UPDATE' } });
  assert(notice && !/Paciente|\d{1,2}:\d{2}/.test(`${notice.title} ${notice.body}`), 'el aviso al paciente es genérico (sin nombre ni hora)');

  console.log('8/9 Controles de Argos');
  // Una solicitud pendiente más para que la bandeja tenga filas en todos los estados relevantes.
  const s1 = await ok(p1.jar, `/portal/booking/slots?therapistId=${t1.id}`);
  await ok(p1.jar, '/portal/booking/requests', { method: 'POST', body: { therapistId: t1.id, startsAt: futureSlots(s1.slots, 3)[30].startsAt } });
  // 8a. /scheduling/professionals
  const idsOf = (r) => r.professionals.map((p) => p.id).sort();
  const asT1 = await ok(t1.jar, '/scheduling/professionals');
  assert(JSON.stringify(idsOf(asT1)) === JSON.stringify([t1.id]), 'THERAPIST solo se ve a sí mismo en /scheduling/professionals');
  const asT2 = await ok(t2.jar, '/scheduling/professionals');
  assert(JSON.stringify(idsOf(asT2)) === JSON.stringify([t2.id]), 'el otro THERAPIST del mismo espacio tampoco ve a T1');
  const asTb = await ok(tb.jar, '/scheduling/professionals');
  assert(JSON.stringify(idsOf(asTb)) === JSON.stringify([tb.id]), 'THERAPIST de otro espacio solo se ve a sí mismo');
  const asOwner = await ok(owner.jar, '/scheduling/professionals');
  assert(JSON.stringify(idsOf(asOwner)) === JSON.stringify([t1.id, t2.id].sort()), 'OWNER ve a los clínicos de SU espacio y a ninguno del otro');
  const asAssistant = await ok(assistant.jar, '/scheduling/professionals');
  assert(!idsOf(asAssistant).includes(tb.id) && idsOf(asAssistant).length === 2, 'ASSISTANT ve los del espacio y ninguno de otro');
  assert(!JSON.stringify(asT1).includes(t2.id) && !JSON.stringify(asT1).includes(tb.id), 'la respuesta de T1 no menciona a ningún otro profesional');
  assert((await call(newJar(), '/scheduling/professionals')).status === 401, 'sin sesión: 401');
  // 8b. Ningún JSON del módulo lleva `email`.
  const allEmails = [owner, t1, t2, assistant, tb].map((m) => m.email).concat([p1, p2, p3, p4].map((p) => p.email));
  const jsons = {
    'professionals(T1)': asT1, 'professionals(T2)': asT2, 'professionals(TB)': asTb, 'professionals(OWNER)': asOwner, 'professionals(ASSISTANT)': asAssistant,
    availability: await ok(t1.jar, `/scheduling/availability/${t1.id}`),
    requests: await ok(t1.jar, '/scheduling/requests'),
    requestsOwner: await ok(owner.jar, '/scheduling/requests'),
    pending: await ok(t1.jar, '/scheduling/requests/pending-count'),
    portalOptions: await ok(p1.jar, '/portal/booking/options'),
    portalSlots: s1,
    portalRequests: await ok(p1.jar, '/portal/booking/requests'),
  };
  for (const [name, body] of Object.entries(jsons)) {
    const text = JSON.stringify(body);
    assert(!keysDeep(body).has('email'), `${name}: el JSON contiene una clave "email"`);
    assert(!allEmails.some((e) => text.includes(e)) && !/@example\.test/.test(text), `${name}: el JSON contiene una dirección de correo`);
    assert(!/passwordHash|mfaSecret/.test(text), `${name}: filtra credenciales`);
  }
  // 8c. /scheduling/requests: ni claves clínicas ni los textos clínicos sembrados.
  const allowedRow = new Set(['id', 'type', 'status', 'startsAt', 'endsAt', 'sessionId', 'accessorType', 'rejectionReason', 'expiresAt', 'createdAt', 'resolvedAt', 'patient', 'therapist', 'session']);
  const forbidden = ['consultationReason', 'reason', 'title', 'notes', 'summary', 'goals', 'objectives', 'diagnosis', 'clinicalProcess', 'clinicalProcessId', 'history', 'body', 'description', 'content', 'score', 'scores', 'privateNotes', 'internalNotes'];
  for (const [name, jar] of [['THERAPIST', t1.jar], ['OWNER', owner.jar], ['ASSISTANT', assistant.jar]]) {
    const list = await ok(jar, '/scheduling/requests');
    assert(list.length >= 5, `${name}: la bandeja tiene filas con las que comprobar (hay ${list.length})`);
    for (const row of list) {
      for (const key of Object.keys(row)) assert(allowedRow.has(key), `${name}: clave inesperada en una solicitud: ${key}`);
      assert(Object.keys(row.patient).sort().join() === 'firstName,id,lastName' && Object.keys(row.therapist).sort().join() === 'firstName,id,lastName', `${name}: patient y therapist solo llevan id y nombre`);
    }
    const keys = keysDeep(list);
    for (const k of forbidden) assert(!keys.has(k), `${name}: /scheduling/requests devuelve la clave clínica "${k}"`);
    const text = JSON.stringify(list);
    assert(!text.includes(CONSULTATION_MARKER) && !text.includes(PROCESS_MARKER) && !/enc:v[12]:/.test(text), `${name}: aparecen textos clínicos`);
  }
  assert((await ok(t2.jar, '/scheduling/requests')).length === 0, 'T2 no ve solicitudes de T1');
  assert((await ok(tb.jar, '/scheduling/requests')).length === 0, 'otro espacio no ve ninguna');

  console.log('9/9 Auditoría y aislamiento por espacio en la BD');
  assert(await prisma.appointmentRequest.count({ where: { workspaceId: wsB.id } }) === 0, 'ninguna solicitud cae en el espacio B');
  const audits = await prisma.auditLog.findMany({ where: { workspaceId: wsA.id, action: { startsWith: 'APPOINTMENT_REQUEST_' } }, select: { action: true, metadata: true } });
  assert(audits.length >= 10, `hay auditoría de las solicitudes (${audits.length})`);
  assert(!JSON.stringify(audits).includes(CONSULTATION_MARKER) && !/example\.test/.test(JSON.stringify(audits)), 'la auditoría no guarda texto clínico ni correos');
  console.log(`\nOK: reserva de citas verificada contra la API real y PostgreSQL (${checks} comprobaciones)`);
}

main().then(() => prisma.$disconnect()).catch(async (error) => {
  console.error(String(error?.message ?? error));
  await prisma.$disconnect();
  process.exit(1);
});
