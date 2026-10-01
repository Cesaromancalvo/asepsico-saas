// Verificación contra API y PostgreSQL reales del modelo de acceso clínico por proceso ACTIVO
// (feat/e1-acceso-clinico). Datos 100 % ficticios.
//
// SOLO para BD desechables: crea un workspace de prueba con seis actores, les activa MFA por la
// API y deja los datos en la BD (no se limpian; la BD es de usar y tirar).
//
// Actores: OWNER no clínico, ADMIN clínico sin proceso, THERAPIST con proceso ACTIVO, autor de un
// proceso CLOSED, autor de un proceso PAUSED y ASSISTANT.
// Comprueba: matriz de lectura (historia, motivo, proceso, sesión, hilo de mensajes, exportación),
// que cada 403 por acceso clínico deja CLINICAL_ACCESS_DENIED sin contenido en los metadatos, las
// ventanas de mensajes (pausa + cambio de modalidad no la amplían; un clínico nuevo no ve lo
// anterior a su proceso), PATCH therapistId → 400 sin escritura ni auditoría de cambio, y
// PATCH /workspace-members/:id/clinician (ADMIN → 403, destino ASSISTANT → 400).
//
// Requisitos: API local arrancada con TRUST_PROXY=loopback (cada actor usa su propia IP vía
// X-Forwarded-For para no compartir el límite de login) y DATABASE_URL de la misma BD.
// Variables: ASEPSICO_API_URL, DATABASE_URL. Nunca imprime secretos, códigos ni tokens.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const API = process.env.ASEPSICO_API_URL || 'http://127.0.0.1:4000/api/v1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (!LOCAL_HOSTS.has(new URL(API).hostname)) throw new Error('Solo contra una API local sobre una BD desechable');
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL (la misma BD desechable que usa la API)');

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { generate } = requireFromApi('otplib');
const bcrypt = requireFromApi('bcryptjs');
const { PrismaClient } = requireFromApi('@prisma/client');
const prisma = new PrismaClient();

const stamp = Date.now();
const password = 'Aa1' + randomBytes(15).toString('base64url');
const MARK = `QAE1${stamp}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
let checks = 0;
function check(ok, label) {
  checks += 1;
  if (ok) { console.log(`   ok  ${label}`); return; }
  failures += 1;
  console.log(`   FALLO ${label}`);
}
function must(ok, label) { if (!ok) throw new Error(label); }

let ipSeq = 0;
function client(name) {
  const cookies = new Map();
  const ip = `198.51.100.${++ipSeq}`;
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { 'x-forwarded-for': ip };
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const csrf = cookies.get('csrf_token');
    if (!['GET', 'HEAD'].includes(method) && csrf) headers['x-csrf-token'] = decodeURIComponent(csrf);
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const raw of res.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, text };
  }
  async function ok(path, options) {
    const res = await call(path, options);
    if (res.status >= 300) throw new Error(`${name} ${options?.method ?? 'GET'} ${path}: ${res.status} ${res.text.slice(0, 200)}`);
    return res.data;
  }
  return { name, call, ok };
}

async function login(actor, email, needsMfa) {
  const result = await actor.ok('/auth/login', { method: 'POST', body: { email, password } });
  actor.userId = result.user?.id;
  if (!needsMfa) return;
  const setup = await actor.ok('/auth/mfa/setup', { method: 'POST' });
  await actor.ok('/auth/mfa/confirm', { method: 'POST', body: { password, code: await generate({ secret: setup.secret }) } });
  await actor.ok('/auth/refresh', { method: 'POST' });
}

// Filas nuevas por diferencia de ids (no por fecha: el reloj del contenedor de Postgres y el del
// host pueden no coincidir y una ventana por createdAt contaría filas de peticiones anteriores).
async function deniedIds(userId) {
  const rows = await prisma.auditLog.findMany({ where: { actorId: userId, action: 'CLINICAL_ACCESS_DENIED' }, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}
async function newDeniedRows(userId, seen) {
  const rows = await prisma.auditLog.findMany({ where: { actorId: userId, action: 'CLINICAL_ACCESS_DENIED' } });
  return rows.filter((row) => !seen.has(row.id));
}

// Petición que debe dar 403 sin filtrar contenido y dejar CLINICAL_ACCESS_DENIED limpio.
async function expectDenied(actor, label, path, options) {
  const seen = await deniedIds(actor.userId);
  const res = await actor.call(path, options);
  check(res.status === 403, `${actor.name}: ${label} → 403 (llegó ${res.status})`);
  check(!res.text.includes(MARK), `${actor.name}: ${label} → el 403 no lleva contenido clínico`);
  const rows = await newDeniedRows(actor.userId, seen);
  check(rows.length >= 1, `${actor.name}: ${label} → CLINICAL_ACCESS_DENIED auditado (${rows.length})`);
  for (const row of rows) {
    const keys = Object.keys(row.metadata ?? {}).sort().join(',');
    check(keys === 'reason,resource,role' && !JSON.stringify(row).includes(MARK),
      `${actor.name}: ${label} → metadatos solo {resource,reason,role} (${keys}; ${row.metadata?.reason})`);
  }
  return res;
}

async function main() {
  console.log('1. Preparar workspace ficticio y actores');
  const hash = await bcrypt.hash(password, 10);
  const workspace = await prisma.workspace.create({ data: { name: `Consulta QA E1 ${stamp}` } });
  const defs = {
    owner: { role: 'OWNER', isClinician: false, mfa: true },
    admin: { role: 'ADMIN', isClinician: false, mfa: true }, // se marca clínico por la API (OWNER)
    active: { role: 'THERAPIST', isClinician: true, mfa: true },
    closed: { role: 'THERAPIST', isClinician: true, mfa: true },
    paused: { role: 'THERAPIST', isClinician: true, mfa: true },
    assistant: { role: 'ASSISTANT', isClinician: false, mfa: false },
  };
  const A = {};
  for (const [key, def] of Object.entries(defs)) {
    const email = `qa-e1-${key}-${stamp}@example.test`;
    const user = await prisma.user.create({ data: { email, passwordHash: hash, firstName: `QA ${key}`, lastName: 'Ficticio' } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: def.role, isClinician: def.isClinician } });
    A[key] = client(key);
    await login(A[key], email, def.mfa);
    must(A[key].userId === user.id, `login de ${key} no devolvió su id`);
  }

  console.log('2. Gestión del atributo clínico (PATCH /workspace-members/:id/clinician)');
  const adminTry = await A.admin.call(`/workspace-members/${A.closed.userId}/clinician`, { method: 'PATCH', body: { isClinician: false } });
  check(adminTry.status === 403, `ADMIN cambia isClinician → 403 (llegó ${adminTry.status})`);
  const toAssistant = await A.owner.call(`/workspace-members/${A.assistant.userId}/clinician`, { method: 'PATCH', body: { isClinician: true } });
  check(toAssistant.status === 400, `OWNER marca clínico a un ASSISTANT → 400 (llegó ${toAssistant.status})`);
  const assistantRow = await prisma.workspaceMember.findFirst({ where: { workspaceId: workspace.id, userId: A.assistant.userId } });
  check(assistantRow.isClinician === false, 'ASSISTANT sigue sin isClinician');
  const closedRow = await prisma.workspaceMember.findFirst({ where: { workspaceId: workspace.id, userId: A.closed.userId } });
  check(closedRow.isClinician === true, 'el PATCH rechazado del ADMIN no cambió nada');
  const toTherapist = await A.owner.call(`/workspace-members/${A.closed.userId}/clinician`, { method: 'PATCH', body: { isClinician: false } });
  check(toTherapist.status === 400, `OWNER quita isClinician a un THERAPIST → 400 (llegó ${toTherapist.status})`);
  const therapistRow = await prisma.workspaceMember.findFirst({ where: { workspaceId: workspace.id, userId: A.closed.userId } });
  check(therapistRow.isClinician === true, 'el THERAPIST sigue siendo clínico');

  // Alta: el OWNER nace no clínico salvo que marque isClinician en el registro.
  for (const flag of [undefined, true]) {
    const reg = client(`registro-${flag ?? 'sin-flag'}`);
    const email = `qa-e1-registro-${flag ?? 'no'}-${stamp}@example.test`;
    const body = { firstName: 'Titular', lastName: 'Ficticio', email, password, workspaceName: `Consulta QA registro ${stamp}`, ...(flag === undefined ? {} : { isClinician: flag }) };
    const res = await reg.call('/auth/register', { method: 'POST', body });
    const member = await prisma.workspaceMember.findFirst({ where: { user: { email } } });
    check(res.status < 300 && member?.role === 'OWNER' && member.isClinician === (flag === true),
      `registro ${flag === undefined ? 'sin isClinician' : 'con isClinician=true'} → OWNER isClinician=${member?.isClinician} (${res.status})`);
  }

  const adminOk = await A.owner.call(`/workspace-members/${A.admin.userId}/clinician`, { method: 'PATCH', body: { isClinician: true } });
  check(adminOk.status === 200, `OWNER marca clínico al ADMIN → 200 (llegó ${adminOk.status})`);

  console.log('3. Datos clínicos ficticios con su secuencia temporal');
  const patient = await A.closed.ok('/patients', { method: 'POST', body: { firstName: 'Paciente', lastName: `QA E1 ${stamp}`, consultationReason: `${MARK} motivo` } });
  let hour = 9;
  const slot = () => { const start = new Date(); start.setDate(start.getDate() + 3); start.setHours(hour++, 0, 0, 0); return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 45 * 60_000).toISOString() }; };

  // Autor del proceso CERRADO: proceso, sesión con notas, conversación y mensaje; luego cierra.
  const cpClosed = await A.closed.ok('/clinical-processes', { method: 'POST', body: { patientId: patient.id, title: `${MARK} proceso cerrado`, internalNotes: `${MARK} interna closed` } });
  const sClosed = await A.closed.ok('/sessions', { method: 'POST', body: { patientId: patient.id, clinicalProcessId: cpClosed.id, ...slot(), notes: `${MARK} nota closed` } });
  const conversation = await A.closed.ok(`/patients/${patient.id}/conversation`, { method: 'POST' });
  const mClosed = await A.closed.ok(`/messages/${conversation.id}`, { method: 'POST', body: { body: `${MARK} mensaje closed` } });
  await sleep(30);
  await A.closed.ok(`/clinical-processes/${cpClosed.id}/status`, { method: 'PATCH', body: { status: 'CLOSED' } });
  await sleep(30);

  // Autor del proceso EN PAUSA: proceso, sesión, mensaje; pausa y luego cambia la modalidad.
  const cpPaused = await A.paused.ok('/clinical-processes', { method: 'POST', body: { patientId: patient.id, title: `${MARK} proceso pausado` } });
  const sPaused = await A.paused.ok('/sessions', { method: 'POST', body: { patientId: patient.id, clinicalProcessId: cpPaused.id, ...slot(), notes: `${MARK} nota paused` } });
  const mPaused = await A.paused.ok(`/messages/${conversation.id}`, { method: 'POST', body: { body: `${MARK} mensaje paused` } });
  await sleep(30);
  await A.paused.ok(`/clinical-processes/${cpPaused.id}/status`, { method: 'PATCH', body: { status: 'PAUSED' } });
  const pausedRow1 = await prisma.clinicalProcess.findUnique({ where: { id: cpPaused.id } });
  await sleep(30);
  const modality = await A.paused.call(`/clinical-processes/${cpPaused.id}`, { method: 'PATCH', body: { modality: 'ONLINE' } });
  check(modality.status === 200, `autor PAUSED cambia la modalidad → 200 (llegó ${modality.status})`);
  const pausedRow2 = await prisma.clinicalProcess.findUnique({ where: { id: cpPaused.id } });
  check(pausedRow1.pausedAt && +pausedRow2.pausedAt === +pausedRow1.pausedAt && +pausedRow2.updatedAt > +pausedRow1.pausedAt,
    'pausedAt fijo tras cambiar la modalidad (updatedAt sí se mueve)');
  await sleep(30);

  // Clínico con proceso ACTIVO, abierto después: historia, sesión y mensaje propios.
  const cpActive = await A.active.ok('/clinical-processes', { method: 'POST', body: { patientId: patient.id, title: `${MARK} proceso activo`, internalNotes: `${MARK} interna active` } });
  await A.active.ok(`/patients/${patient.id}/history`, { method: 'PATCH', body: { reasonForConsultation: `${MARK} historia` } });
  const sActive = await A.active.ok('/sessions', { method: 'POST', body: { patientId: patient.id, clinicalProcessId: cpActive.id, ...slot(), notes: `${MARK} nota active` } });
  const mActive = await A.active.ok(`/messages/${conversation.id}`, { method: 'POST', body: { body: `${MARK} mensaje active` } });

  console.log('4. Matriz de lectura');
  const exportBody = { method: 'POST', body: { password } };
  // Clínico con proceso ACTIVO: todo, sin notas internas ajenas.
  check((await A.active.call(`/patients/${patient.id}/history`)).data?.reasonForConsultation === `${MARK} historia`, 'active: historia 200');
  check((await A.active.call(`/patients/${patient.id}/consultation-reason`)).data?.consultationReason === `${MARK} motivo`, 'active: motivo 200');
  const activeOwn = await A.active.call(`/clinical-processes/${cpActive.id}`);
  check(activeOwn.status === 200 && activeOwn.data.internalNotes === `${MARK} interna active`, 'active: su proceso con sus notas internas');
  const activeOther = await A.active.call(`/clinical-processes/${cpClosed.id}`);
  check(activeOther.status === 200 && !('internalNotes' in activeOther.data) && !activeOther.text.includes(`${MARK} interna closed`), 'active: proceso cerrado ajeno 200 sin notas internas ajenas');
  check((await A.active.call(`/sessions/${sActive.id}`)).data?.notes === `${MARK} nota active`, 'active: su sesión con notas');
  const activeExport = await A.active.call(`/exports/patients/${patient.id}`, exportBody);
  check(activeExport.status === 201 || activeExport.status === 200, `active: exportación ${activeExport.status}`);
  check(!activeExport.text.includes(`${MARK} interna closed`), 'active: exportación sin notas internas ajenas');

  // Autores de procesos CLOSED / PAUSED: solo lo suyo y en lectura.
  for (const [key, cpOwn, sOwn, cpOther] of [['closed', cpClosed, sClosed, cpActive], ['paused', cpPaused, sPaused, cpActive]]) {
    const actor = A[key];
    await expectDenied(actor, 'historia', `/patients/${patient.id}/history`);
    await expectDenied(actor, 'motivo de consulta', `/patients/${patient.id}/consultation-reason`);
    const own = await actor.call(`/clinical-processes/${cpOwn.id}`);
    check(own.status === 200 && own.data.readOnly === true, `${key}: su proceso 200 en solo lectura`);
    await expectDenied(actor, 'proceso activo ajeno', `/clinical-processes/${cpOther.id}`);
    check((await actor.call(`/sessions/${sOwn.id}`)).data?.notes === `${MARK} nota ${key}`, `${key}: su sesión con notas`);
    const seenSession = await deniedIds(actor.userId);
    const otherSession = await actor.call(`/sessions/${sActive.id}`);
    check(otherSession.status === 403 && !otherSession.text.includes(MARK), `${key}: sesión ajena → ${otherSession.status} sin contenido`);
    console.log(`        (${key} sesión ajena: filas CLINICAL_ACCESS_DENIED = ${(await newDeniedRows(actor.userId, seenSession)).length})`);
    const exp = await actor.call(`/exports/patients/${patient.id}`, exportBody);
    check((exp.status === 201 || exp.status === 200) && exp.text.includes(`${MARK} nota ${key}`) && !exp.text.includes(`${MARK} nota active`) && !exp.text.includes(`${MARK} historia`) && !exp.text.includes(`${MARK} motivo`),
      `${key}: exportación ${exp.status} solo con lo suyo (sin historia, motivo ni sesiones ajenas)`);
    const write = await actor.call(`/patients/${patient.id}/history`, { method: 'PATCH', body: { reasonForConsultation: 'no debe guardarse' } });
    check(write.status === 403, `${key}: escribir historia → 403 (llegó ${write.status})`);
  }

  // OWNER no clínico, ADMIN clínico sin proceso: nada clínico.
  for (const key of ['owner', 'admin']) {
    const actor = A[key];
    await expectDenied(actor, 'historia', `/patients/${patient.id}/history`);
    await expectDenied(actor, 'motivo de consulta', `/patients/${patient.id}/consultation-reason`);
    await expectDenied(actor, 'proceso', `/clinical-processes/${cpActive.id}`);
    const session = await actor.call(`/sessions/${sActive.id}`);
    check(session.status === 200 && !session.text.includes(MARK) && !('notes' in session.data), `${key}: sesión → vista administrativa sin notas ni título`);
    await expectDenied(actor, 'hilo de mensajes', `/messages/${conversation.id}`);
    await expectDenied(actor, 'exportación del paciente', `/exports/patients/${patient.id}`, exportBody);
    const inbox = await actor.call('/messages');
    check(inbox.status === 200 && !inbox.text.includes(MARK), `${key}: bandeja solo con metadatos`);
  }

  // ASSISTANT: nunca contenido clínico.
  {
    const actor = A.assistant;
    await expectDenied(actor, 'historia', `/patients/${patient.id}/history`);
    await expectDenied(actor, 'motivo de consulta', `/patients/${patient.id}/consultation-reason`);
    for (const [label, path, options] of [
      ['proceso', `/clinical-processes/${cpActive.id}`],
      ['hilo de mensajes', `/messages/${conversation.id}`],
      ['exportación del paciente', `/exports/patients/${patient.id}`, exportBody],
    ]) {
      const seen = await deniedIds(actor.userId);
      const res = await actor.call(path, options);
      const audited = (await newDeniedRows(actor.userId, seen)).length;
      check(res.status === 403 && !res.text.includes(MARK), `assistant: ${label} → 403 sin contenido (llegó ${res.status})`);
      console.log(`        (assistant ${label}: filas CLINICAL_ACCESS_DENIED = ${audited})`);
    }
    const session = await actor.call(`/sessions/${sActive.id}`);
    check(session.status === 200 && !session.text.includes(MARK), 'assistant: sesión → solo metadatos');
  }

  console.log('5. Ventanas de mensajes');
  const ids = (res) => new Set((res.data?.messages ?? []).map((m) => m.id));
  const tClosed = ids(await A.closed.call(`/messages/${conversation.id}`));
  check(tClosed.has(mClosed.id) && tClosed.size === 1, `closed: solo su mensaje (${tClosed.size})`);
  const tPaused = ids(await A.paused.call(`/messages/${conversation.id}`));
  check(tPaused.has(mPaused.id) && tPaused.size === 1, `paused: solo el de su ventana; la modalidad no la amplía (${tPaused.size})`);
  const tActive = ids(await A.active.call(`/messages/${conversation.id}`));
  check(tActive.has(mActive.id) && !tActive.has(mClosed.id) && !tActive.has(mPaused.id), `active: no ve mensajes anteriores a su proceso (${tActive.size})`);

  console.log('6. PATCH therapistId distinto → 400 sin escritura ni CLINICAL_PROCESS_UPDATED');
  const before = await prisma.clinicalProcess.findUnique({ where: { id: cpActive.id } });
  const updatesBefore = await prisma.auditLog.count({ where: { entityId: cpActive.id, action: 'CLINICAL_PROCESS_UPDATED' } });
  for (const actor of [A.active, A.owner]) {
    const res = await actor.call(`/clinical-processes/${cpActive.id}`, { method: 'PATCH', body: { therapistId: A.paused.userId, frequency: 'semanal' } });
    check(res.status === 400, `${actor.name}: PATCH therapistId → 400 (llegó ${res.status})`);
  }
  const after = await prisma.clinicalProcess.findUnique({ where: { id: cpActive.id } });
  const updatesAfter = await prisma.auditLog.count({ where: { entityId: cpActive.id, action: 'CLINICAL_PROCESS_UPDATED' } });
  check(after.therapistId === before.therapistId && after.frequency === before.frequency && +after.updatedAt === +before.updatedAt, 'proceso sin cambios en la BD');
  check(updatesAfter === updatesBefore, `sin filas CLINICAL_PROCESS_UPDATED nuevas (${updatesBefore} → ${updatesAfter})`);

  console.log(`\nResultado: ${checks - failures}/${checks} comprobaciones, ${failures} fallos`);
  if (failures) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(`FALLO: ${error.message}`);
} finally {
  await prisma.$disconnect();
}
