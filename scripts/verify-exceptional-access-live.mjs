// Verificación contra API y PostgreSQL reales del acceso excepcional (H1–H6,
// docs/producto/acceso-excepcional.md) con las condiciones de Argos. Datos 100 % ficticios.
//
// SOLO para BD desechables: crea un workspace de prueba, actores con MFA activado por la API,
// pacientes y contenido clínico ficticio, y filas "antiguas" de AuditLog con el motivo en claro.
// No limpia nada (la BD es de usar y tirar).
//
// Comprueba:
//  1. H6 / CA6.8: N altas simultáneas sin código sobre un paciente sin historia → solo una pasa
//     (THERAPIST: el resto 403; OWNER/ADMIN: el resto 400 OPENING_REASON_REQUIRED), sin timeouts.
//  2. H6 / CA6.1: el 403 deja CLINICAL_ACCESS_DENIED con reason FOREIGN_HISTORY y no crea proceso
//     ni registro de apertura.
//  3. Exportación con EXCEPTIONAL (CA2.7): CONTINUITY_OF_CARE → 403 auditado; LEGAL_REQUIREMENT →
//     sale sin internalNotes, internalSummary, clinicianNotes, clinicalNotes ni notas de consentimiento.
//  4. Ciclo de sesión (C3, CA2.4): login + registrar + leer; refrescar (sigue valiendo; 403 solo
//     durante la rotación); logout con el access token vivo → 403; otro dispositivo → 403.
//  5. H5: db:migrate-exceptional-reasons sobre filas antiguas (una sin actor): dry-run cuenta las
//     omitidas, dos ejecuciones idempotentes y ninguna metadata conserva `reason`.
//
// Requisitos: API local arrancada con TRUST_PROXY=loopback sobre la misma BD (DATABASE_URL) y la
// misma clave de cifrado (vacía en local = clave de desarrollo; el CLI se lanza con --allow-dev-key).
// Variables: ASEPSICO_API_URL, DATABASE_URL, opcional QA_CONCURRENCY_ROUNDS (por defecto 10).
// Nunca imprime secretos, códigos, tokens ni el texto de las explicaciones.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = process.env.ASEPSICO_API_URL || 'http://127.0.0.1:4000/api/v1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (!LOCAL_HOSTS.has(new URL(API).hostname)) throw new Error('Solo contra una API local sobre una BD desechable');
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL (la misma BD desechable que usa la API)');
if (!LOCAL_HOSTS.has(new URL(process.env.DATABASE_URL).hostname)) throw new Error('Solo contra una BD local desechable');

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { generate } = requireFromApi('otplib');
const bcrypt = requireFromApi('bcryptjs');
const { PrismaClient } = requireFromApi('@prisma/client');
const prisma = new PrismaClient();
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const stamp = Date.now();
const password = 'Aa1' + randomBytes(15).toString('base64url');
const MARK = `QAEX${stamp}`;
const ROUNDS = Number(process.env.QA_CONCURRENCY_ROUNDS || 10);
const TIMEOUT_BUDGET_MS = 5_000; // timeout por defecto de las transacciones interactivas de Prisma

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
  async function call(path, { method = 'GET', body, cookieJar } = {}) {
    const jar = cookieJar ?? cookies;
    const headers = { 'x-forwarded-for': ip };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const csrf = jar.get('csrf_token');
    if (!['GET', 'HEAD'].includes(method) && csrf) headers['x-csrf-token'] = decodeURIComponent(csrf);
    const started = Date.now();
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!cookieJar) {
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        const value = pair.slice(i + 1);
        if (value === '' ) cookies.delete(pair.slice(0, i)); else cookies.set(pair.slice(0, i), value);
      }
    }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, text, ms: Date.now() - started };
  }
  async function ok(path, options) {
    const res = await call(path, options);
    if (res.status >= 300) throw new Error(`${name} ${options?.method ?? 'GET'} ${path}: ${res.status} ${res.text.slice(0, 200)}`);
    return res.data;
  }
  /** Copia de las cookies actuales: un "access token" que se guarda para reutilizarlo después. */
  const snapshot = () => new Map(cookies);
  return { name, call, ok, snapshot, ip };
}

// Un código TOTP no se acepta dos veces (anti-replay): cada login con MFA del mismo usuario
// espera, si hace falta, al siguiente paso de 30 s.
const lastStep = new Map();
async function freshTotp(secret) {
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if (lastStep.get(secret) !== step) { lastStep.set(secret, step); return generate({ secret }); }
    await new Promise((r) => setTimeout(r, (step + 1) * 30_000 - Date.now() + 250));
  }
}

async function login(actor, email, needsMfa) {
  const result = await actor.ok('/auth/login', { method: 'POST', body: { email, password } });
  actor.userId = result.user?.id;
  actor.email = email;
  if (!needsMfa) return;
  if (!actor.totpSecret) {
    const setup = await actor.ok('/auth/mfa/setup', { method: 'POST' });
    await actor.ok('/auth/mfa/confirm', { method: 'POST', body: { password, code: await freshTotp(setup.secret) } });
    actor.totpSecret = setup.secret;
    await actor.ok('/auth/refresh', { method: 'POST' });
  }
}

/** Segundo dispositivo del mismo usuario (otra IP, otra sesión), ya con MFA activado. */
async function loginOtherDevice(original, name) {
  const device = client(name);
  const first = await device.ok('/auth/login', { method: 'POST', body: { email: original.email, password } });
  must(first.mfaRequired === true, `${name}: se esperaba MFA en el login`);
  await device.ok('/auth/login/mfa', { method: 'POST', body: { pendingToken: first.pendingToken, code: await freshTotp(original.totpSecret) } });
  device.userId = original.userId;
  return device;
}

const sameIds = (rows) => new Set(rows.map((row) => row.id));
async function auditIds(where) { return sameIds(await prisma.auditLog.findMany({ where, select: { id: true } })); }
async function newAudit(where, seen) { return (await prisma.auditLog.findMany({ where })).filter((row) => !seen.has(row.id)); }

async function main() {
  console.log('0. Workspace ficticio y actores');
  const hash = await bcrypt.hash(password, 10);
  const workspace = await prisma.workspace.create({ data: { name: `Consulta QA acceso excepcional ${stamp}` } });
  const termsRes = await fetch(`${API}/legal/terms`);
  must(termsRes.ok, `GET /legal/terms → ${termsRes.status}`);
  const acceptedTerms = (await termsRes.json()).map(({ documentType, version, textHash }) => ({ documentType, version, textHash }));
  const defs = {
    owner: { role: 'OWNER', isClinician: false },
    ownerClin: { role: 'OWNER', isClinician: true },
    adminClin: { role: 'ADMIN', isClinician: true },
    t1: { role: 'THERAPIST', isClinician: true },
    t2: { role: 'THERAPIST', isClinician: true },
    t3: { role: 'THERAPIST', isClinician: true },
  };
  const A = {};
  for (const [key, def] of Object.entries(defs)) {
    const email = `qa-ex-${key.toLowerCase()}-${stamp}@example.test`;
    const user = await prisma.user.create({ data: { email, passwordHash: hash, firstName: `QA ${key}`, lastName: 'Ficticio' } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: def.role, isClinician: def.isClinician } });
    await prisma.termsAcceptance.createMany({ data: acceptedTerms.map((t) => ({ workspaceId: workspace.id, userId: user.id, ...t, userAgent: 'verify-exceptional-access-live' })) });
    A[key] = client(key);
    await login(A[key], email, true);
    must(A[key].userId === user.id, `login de ${key} no devolvió su id`);
  }
  const ADMIN_ROLES = new Set(['owner', 'ownerClin', 'adminClin']);
  // OWNER/ADMIN abren a nombre de alguien (therapistId obligatorio); aquí, a sí mismos.
  const openBody = (key, body) => (ADMIN_ROLES.has(key) ? { ...body, therapistId: A[key].userId } : body);
  const newPatient = async (label) => A.owner.ok('/patients', { method: 'POST', body: { firstName: 'Paciente', lastName: `QA ${label} ${stamp}` } });

  console.log(`1. H6 / CA6.8: altas simultáneas sin código (${ROUNDS} rondas por par)`);
  const latencies = [];
  for (const [label, x, y, loserStatus] of [['THERAPIST × THERAPIST', 't1', 't2', 403], ['OWNER × ADMIN (clínicos)', 'ownerClin', 'adminClin', 400]]) {
    let okRounds = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const patient = await newPatient(`conc ${round}`);
      const body = { patientId: patient.id, title: `Proceso concurrente ${round}` };
      const results = await Promise.all([A[x].call('/clinical-processes', { method: 'POST', body: openBody(x, body) }), A[y].call('/clinical-processes', { method: 'POST', body: openBody(y, body) })]);
      latencies.push(...results.map((r) => r.ms));
      const statuses = results.map((r) => r.status).sort();
      const created = await prisma.clinicalProcess.count({ where: { workspaceId: workspace.id, patientId: patient.id } });
      const loser = results.find((r) => r.status !== 201);
      const loserCodeOk = loserStatus === 403 ? loser?.data?.code === 'PATIENT_HAS_FOREIGN_HISTORY' : loser?.data?.code === 'OPENING_REASON_REQUIRED';
      if (statuses[0] === 201 && statuses[1] === loserStatus && created === 1 && loserCodeOk) okRounds += 1;
      else console.log(`        ronda ${round}: estados ${statuses.join('/')} · procesos creados ${created} · código ${loser?.data?.code}`);
    }
    check(okRounds === ROUNDS, `${label}: ${okRounds}/${ROUNDS} rondas con exactamente 1 alta (201) y la otra ${loserStatus}`);
  }
  {
    // Ráfaga: 3 terapeutas + 2 OWNER/ADMIN clínicos a la vez sobre el mismo paciente sin historia.
    const patient = await newPatient('rafaga');
    const body = { patientId: patient.id, title: 'Proceso ráfaga' };
    const actors = ['t1', 't2', 't3', 'ownerClin', 'adminClin'];
    const results = await Promise.all(actors.map((k) => A[k].call('/clinical-processes', { method: 'POST', body: openBody(k, body) })));
    latencies.push(...results.map((r) => r.ms));
    const created = await prisma.clinicalProcess.count({ where: { workspaceId: workspace.id, patientId: patient.id } });
    const statuses = results.map((r, i) => `${actors[i]}:${r.status}`).join(' ');
    check(created === 1 && results.filter((r) => r.status === 201).length === 1 && results.every((r) => [201, 400, 403].includes(r.status)),
      `ráfaga de 5 altas simultáneas → 1 proceso (${statuses})`);
  }
  const maxMs = Math.max(...latencies);
  check(maxMs < TIMEOUT_BUDGET_MS && latencies.every((ms) => ms > 0), `sin timeouts por el lock: ${latencies.length} peticiones, máx ${maxMs} ms (< ${TIMEOUT_BUDGET_MS} ms), ninguna 500`);

  console.log('2. Paciente con contenido clínico ficticio (t1 le trata)');
  const patient = await newPatient('historia');
  const cp = await A.t1.ok('/clinical-processes', { method: 'POST', body: { patientId: patient.id, title: `${MARK} proceso`, internalNotes: `${MARK}-internalNotes` } });
  await A.t1.ok(`/patients/${patient.id}/history`, { method: 'PATCH', body: { reasonForConsultation: `${MARK}-historia` } });
  const start = new Date(); start.setDate(start.getDate() - 2); start.setHours(10, 0, 0, 0);
  const session = await A.t1.ok('/sessions', { method: 'POST', body: { patientId: patient.id, clinicalProcessId: cp.id, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 45 * 60_000).toISOString() } });
  await A.t1.ok(`/sessions/${session.id}/notes`, { method: 'PATCH', body: { notes: `${MARK}-sessionNotes`, internalSummary: `${MARK}-internalSummary` } });
  const task = await A.t1.ok(`/patients/${patient.id}/tasks`, { method: 'POST', body: { title: `${MARK} tarea`, sessionId: session.id } });
  await A.t1.ok(`/patients/${patient.id}/tasks/${task.id}`, { method: 'PATCH', body: { clinicianNotes: `${MARK}-clinicianNotes` } });
  await A.t1.ok(`/patients/${patient.id}/assessments`, { method: 'POST', body: { scaleCode: 'WHO5', answers: [3, 3, 3, 3, 3], clinicalNotes: `${MARK}-clinicalNotes` } });
  let consent = await A.t1.call(`/patients/${patient.id}/consents`, { method: 'POST', body: { type: 'INFORMED_CONSENT', status: 'SIGNED', signedAt: new Date().toISOString(), notes: `${MARK}-consentNotes` } });
  if (consent.status >= 300) consent = await A.owner.call(`/patients/${patient.id}/consents`, { method: 'POST', body: { type: 'INFORMED_CONSENT', status: 'SIGNED', signedAt: new Date().toISOString(), notes: `${MARK}-consentNotes` } });
  must(consent.status < 300, `alta de consentimiento: ${consent.status}`);
  const t1Export = await A.t1.call(`/exports/patients/${patient.id}`, { method: 'POST', body: { password } });
  for (const field of ['internalNotes', 'internalSummary', 'clinicianNotes', 'clinicalNotes', 'consentNotes']) {
    must(t1Export.text.includes(`${MARK}-${field}`), `control: la exportación del terapeuta que trata debería incluir ${field}`);
  }
  console.log('   (control: la exportación de t1 incluye las cinco notas, así que su ausencia después es significativa)');

  console.log('3. H6 / CA6.1: 403 por historia ajena');
  {
    const where = { workspaceId: workspace.id, actorId: A.t2.userId, action: 'CLINICAL_ACCESS_DENIED' };
    const seen = await auditIds(where);
    const before = await prisma.clinicalProcess.count({ where: { workspaceId: workspace.id, patientId: patient.id } });
    const openingsBefore = await prisma.clinicalProcessOpening.count({ where: { workspaceId: workspace.id, patientId: patient.id } });
    const res = await A.t2.call('/clinical-processes', { method: 'POST', body: { patientId: patient.id, title: 'Intento sobre historia ajena', openingReasonCode: 'SUBSTITUTION' } });
    check(res.status === 403 && res.data?.code === 'PATIENT_HAS_FOREIGN_HISTORY', `THERAPIST abre proceso sobre historia ajena (incluso con código) → 403 PATIENT_HAS_FOREIGN_HISTORY (llegó ${res.status} ${res.data?.code})`);
    const rows = await newAudit(where, seen);
    const row = rows[0];
    check(rows.length === 1 && row.entityId === patient.id && row.metadata?.reason === 'FOREIGN_HISTORY' && row.metadata?.resource === 'clinical-process-open-over-history',
      `CLINICAL_ACCESS_DENIED con FOREIGN_HISTORY (${rows.length} fila; ${JSON.stringify(row?.metadata)})`);
    check(!JSON.stringify(rows).includes('Intento sobre historia ajena'), 'la auditoría del 403 no lleva texto de la petición');
    const after = await prisma.clinicalProcess.count({ where: { workspaceId: workspace.id, patientId: patient.id } });
    const openingsAfter = await prisma.clinicalProcessOpening.count({ where: { workspaceId: workspace.id, patientId: patient.id } });
    check(after === before && openingsAfter === openingsBefore, `no se crea proceso ni apertura (procesos ${before}→${after}, aperturas ${openingsBefore}→${openingsAfter})`);
    const opened = await prisma.auditLog.count({ where: { workspaceId: workspace.id, actorId: A.t2.userId, action: { in: ['CLINICAL_PROCESS_CREATED', 'CLINICAL_PROCESS_OPENED_OVER_HISTORY'] }, entityType: 'ClinicalProcess', createdAt: { gte: new Date(Date.now() - 60_000) } } });
    // t2 sí creó procesos en la fase 1; aquí solo comprobamos que ninguno es de este paciente.
    const t2HereProcesses = await prisma.clinicalProcess.count({ where: { workspaceId: workspace.id, patientId: patient.id, therapistId: A.t2.userId } });
    check(t2HereProcesses === 0, `t2 no tiene ningún proceso con el paciente (auditorías de alta recientes de t2 en otros pacientes: ${opened})`);
  }

  console.log('4. Exportación con acceso EXCEPTIONAL (CA2.7)');
  const justification = 'Sustituyo de forma puntual al profesional durante su ausencia ficticia de QA.';
  {
    const access = await A.adminClin.call(`/patients/${patient.id}/exceptional-access`, { method: 'POST', body: { reasonCode: 'CONTINUITY_OF_CARE', justification, confirmed: true } });
    check(access.status === 201, `ADMIN clínico registra CONTINUITY_OF_CARE → 201 (llegó ${access.status})`);
    const history = await A.adminClin.call(`/patients/${patient.id}/history`);
    check(history.status === 200, `ADMIN lee la historia con EXCEPTIONAL → 200 (llegó ${history.status})`);
    const where = { workspaceId: workspace.id, actorId: A.adminClin.userId, action: { in: ['EXCEPTIONAL_ACCESS_EXPORT_DENIED', 'PATIENT_DATA_EXPORTED'] } };
    const seen = await auditIds(where);
    const exp = await A.adminClin.call(`/exports/patients/${patient.id}`, { method: 'POST', body: { password } });
    check(exp.status === 403 && !exp.text.includes(MARK), `CONTINUITY_OF_CARE: exportación → 403 sin contenido (llegó ${exp.status})`);
    const rows = await newAudit(where, seen);
    check(rows.length === 1 && rows[0].action === 'EXCEPTIONAL_ACCESS_EXPORT_DENIED' && rows[0].metadata?.exceptionalAccessId === access.data?.id && rows[0].metadata?.reasonCode === 'CONTINUITY_OF_CARE',
      `CONTINUITY_OF_CARE: intento auditado (${rows.map((r) => r.action).join(',')}) y sin PATIENT_DATA_EXPORTED`);
  }
  {
    const owner = await loginOtherDevice(A.owner, 'owner-export');
    const access = await owner.call(`/patients/${patient.id}/exceptional-access`, { method: 'POST', body: { reasonCode: 'LEGAL_REQUIREMENT', justification: 'Requerimiento ficticio del Juzgado n.º 0, procedimiento QA/2026.', confirmed: true } });
    check(access.status === 201, `OWNER no clínico registra LEGAL_REQUIREMENT → 201 (llegó ${access.status})`);
    const where = { workspaceId: workspace.id, actorId: A.owner.userId, action: 'PATIENT_DATA_EXPORTED' };
    const seen = await auditIds(where);
    const exp = await owner.call(`/exports/patients/${patient.id}`, { method: 'POST', body: { password } });
    check(exp.status === 200 || exp.status === 201, `LEGAL_REQUIREMENT: exportación → ${exp.status}`);
    check(exp.text.includes(`${MARK}-historia`) && exp.text.includes(`${MARK}-sessionNotes`), 'LEGAL_REQUIREMENT: incluye la historia y las notas de sesión (no notas internas)');
    for (const field of ['internalNotes', 'internalSummary', 'clinicianNotes', 'clinicalNotes', 'consentNotes']) {
      check(!exp.text.includes(`${MARK}-${field}`), `LEGAL_REQUIREMENT: sin ${field === 'consentNotes' ? 'notas de consentimiento' : field} (contenido)`);
    }
    const record = exp.data?.data ?? exp.data?.patient ?? exp.data;
    const keyLeak = [];
    const walk = (value, path) => {
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
        if (['internalNotes', 'internalSummary', 'clinicianNotes', 'clinicalNotes'].includes(k) && v != null) keyLeak.push(`${path}.${k}`);
        if (k === 'notes' && /consent/i.test(path) && v != null) keyLeak.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    };
    walk(record, '$');
    check(keyLeak.length === 0, `LEGAL_REQUIREMENT: ninguna clave de nota interna con valor (${keyLeak.slice(0, 5).join(', ') || 'ninguna'})`);
    const rows = await newAudit(where, seen);
    check(rows.length === 1 && rows[0].metadata?.scope === 'EXCEPTIONAL' && rows[0].metadata?.exceptionalAccessId === access.data?.id && rows[0].metadata?.reasonCode === 'LEGAL_REQUIREMENT',
      `LEGAL_REQUIREMENT: PATIENT_DATA_EXPORTED ligado al exceptionalAccessId (${JSON.stringify(rows[0]?.metadata ? Object.keys(rows[0].metadata).sort() : [])})`);
    check(!JSON.stringify(rows).includes('Requerimiento ficticio'), 'la auditoría de la exportación no lleva la explicación');
  }

  console.log('5. Ciclo de sesión (C3 / CA2.4) con el OWNER no clínico');
  const patient2 = await newPatient('sesion');
  await A.t1.ok('/clinical-processes', { method: 'POST', body: { patientId: patient2.id, title: `${MARK} proceso 2` } });
  await A.t1.ok(`/patients/${patient2.id}/history`, { method: 'PATCH', body: { reasonForConsultation: `${MARK}-historia2` } });
  const owner = await loginOtherDevice(A.owner, 'owner-sesion');
  const historyPath = `/patients/${patient2.id}/history`;
  {
    const denied = await owner.call(historyPath);
    check(denied.status === 403, `sin acceso: historia → 403 (llegó ${denied.status})`);
    const access = await owner.call(`/patients/${patient2.id}/exceptional-access`, { method: 'POST', body: { reasonCode: 'PATIENT_RIGHTS_REQUEST', justification: 'Solicitud ficticia de acceso del paciente recibida para QA.', confirmed: true } });
    check(access.status === 201, `registrar acceso → 201 (llegó ${access.status})`);
    owner.accessId = access.data?.id;
    const seen = await auditIds({ workspaceId: workspace.id, actorId: A.owner.userId, action: 'EXCEPTIONAL_ACCESS_READ' });
    const read = await owner.call(historyPath);
    check(read.status === 200 && read.data?.reasonForConsultation === `${MARK}-historia2`, `leer con acceso → 200 (llegó ${read.status})`);
    const reads = await newAudit({ workspaceId: workspace.id, actorId: A.owner.userId, action: 'EXCEPTIONAL_ACCESS_READ' }, seen);
    check(reads.length >= 1 && reads.every((r) => r.metadata?.exceptionalAccessId === owner.accessId), `lectura auditada con exceptionalAccessId (${reads.length})`);
  }
  {
    const preRefresh = owner.snapshot();
    const refreshed = await owner.call('/auth/refresh', { method: 'POST' });
    check(refreshed.status === 200, `refresh → 200 (llegó ${refreshed.status})`);
    check((await owner.call(historyPath)).status === 200, 'tras refrescar, el token nuevo sigue leyendo (misma sesión)');
    check((await owner.call(historyPath, { cookieJar: preRefresh })).status === 200, 'tras refrescar, el access token anterior (mismo sid) sigue leyendo');

    // Rotación: lecturas en paralelo a varios refresh. Las que caigan entre la revocación del
    // token viejo y el alta del nuevo pueden dar 403; las de después, nunca.
    const statuses = { during: [], after: [] };
    for (let i = 0; i < 4; i += 1) {
      const jar = owner.snapshot();
      const reads = Array.from({ length: 12 }, (_, k) => new Promise((r) => setTimeout(r, k * 2)).then(() => owner.call(historyPath, { cookieJar: jar })));
      const rotation = owner.call('/auth/refresh', { method: 'POST' });
      const [rot, ...rs] = await Promise.all([rotation, ...reads]);
      must(rot.status === 200, `refresh de rotación ${i}: ${rot.status}`);
      statuses.during.push(...rs.map((r) => r.status));
      const post = await Promise.all(Array.from({ length: 5 }, () => owner.call(historyPath, { cookieJar: jar })));
      statuses.after.push(...post.map((r) => r.status));
    }
    const count = (list, s) => list.filter((x) => x === s).length;
    console.log(`        durante la rotación: ${count(statuses.during, 200)}×200, ${count(statuses.during, 403)}×403 de ${statuses.during.length}`);
    check(statuses.during.every((s) => s === 200 || s === 403), 'durante la rotación solo 200 o 403 (nunca 401/500)');
    check(statuses.after.every((s) => s === 200), `después de cada rotación todo 200 (${count(statuses.after, 200)}/${statuses.after.length})`);
  }
  {
    const other = await loginOtherDevice(A.owner, 'owner-otro-dispositivo');
    const res = await other.call(historyPath);
    check(res.status === 403 && !res.text.includes(MARK), `otro dispositivo del mismo OWNER → 403 (llegó ${res.status})`);
    const current = await other.call(`/patients/${patient2.id}/exceptional-access/current`);
    check(current.status === 200 && current.data?.active === null, 'otro dispositivo: /current sin acceso activo');
    check((await owner.call(historyPath)).status === 200, 'el dispositivo original sigue leyendo');
  }
  {
    const aliveAccessToken = owner.snapshot();
    const out = await owner.call('/auth/logout', { method: 'POST' });
    check(out.status === 200, `logout → 200 (llegó ${out.status})`);
    const res = await owner.call(historyPath, { cookieJar: aliveAccessToken });
    check(res.status === 403 && !res.text.includes(MARK), `tras logout, el access token todavía vivo → 403 (llegó ${res.status})`);
    const row = await prisma.exceptionalAccessJustification.findUnique({ where: { id: owner.accessId } });
    check(row?.closedAt && row.closeReason === 'LOGOUT', `el acceso queda cerrado en la BD (closeReason ${row?.closeReason})`);
  }

  console.log('6. H5: migración de motivos antiguos en claro (db:migrate-exceptional-reasons)');
  {
    // Filas con la MISMA forma que escribía el endpoint antiguo (dcf65f7, patients/exceptional-access.controller.ts):
    // action EXCEPTIONAL_CLINICAL_ACCESS, entityType Patient, entityId paciente, metadata { reason, role }.
    const legacyUser = await prisma.user.create({ data: { email: `qa-ex-legacy-${stamp}@example.test`, passwordHash: hash, firstName: 'QA legacy', lastName: 'Ficticio' } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: legacyUser.id, role: 'ADMIN', isClinician: false } });
    const legacyReasons = [`${MARK}-legacy-1 revisión de duplicado`, `${MARK}-legacy-2 petición del paciente`, `${MARK}-legacy-3 sin actor`];
    const legacy = [];
    legacy.push(await prisma.auditLog.create({ data: { workspaceId: workspace.id, actorId: A.owner.userId, action: 'EXCEPTIONAL_CLINICAL_ACCESS', entityType: 'Patient', entityId: patient.id, metadata: { reason: legacyReasons[0], role: 'OWNER' }, createdAt: new Date(Date.now() - 30 * 86_400_000) } }));
    legacy.push(await prisma.auditLog.create({ data: { workspaceId: workspace.id, actorId: A.adminClin.userId, action: 'EXCEPTIONAL_CLINICAL_ACCESS', entityType: 'Patient', entityId: patient2.id, metadata: { reason: legacyReasons[1], role: 'ADMIN' } } }));
    legacy.push(await prisma.auditLog.create({ data: { workspaceId: workspace.id, actorId: legacyUser.id, action: 'EXCEPTIONAL_CLINICAL_ACCESS', entityType: 'Patient', entityId: patient.id, metadata: { reason: legacyReasons[2], role: 'ADMIN' } } }));
    // "Sin actor" por el camino real: se borra el usuario y la FK pone actorId a NULL (onDelete: SetNull).
    await prisma.workspaceMember.deleteMany({ where: { userId: legacyUser.id } });
    await prisma.termsAcceptance.deleteMany({ where: { userId: legacyUser.id } });
    await prisma.user.delete({ where: { id: legacyUser.id } });
    const orphan = await prisma.auditLog.findUnique({ where: { id: legacy[2].id } });
    must(orphan.actorId === null, 'la fila antigua sin actor debería tener actorId NULL');

    const withReason = async () => (await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AuditLog" WHERE metadata ? 'reason' AND action = 'EXCEPTIONAL_CLINICAL_ACCESS'`))[0].n;
        const orphansExpected = (await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'EXCEPTIONAL_CLINICAL_ACCESS' AND jsonb_typeof(metadata->'reason') = 'string' AND ("actorId" IS NULL OR "entityId" IS NULL)`))[0].n;
    const expectedFound = await withReason();
    const runCli = (extra) => execFileSync('npm', ['--workspace', '@asepsico/api', 'run', '--silent', 'db:migrate-exceptional-reasons', '--', ...extra], { cwd: REPO_ROOT, env: process.env, encoding: 'utf8' });
    const parse = (out) => {
      const m = out.match(/Registros con motivo en claro: (\d+) · migrados: (\d+) · sin paciente o actor \(motivo descartado sin migrar\): (\d+)/);
      return m ? { found: +m[1], migrated: +m[2], skipped: +m[3], leaked: legacyReasons.some((r) => out.includes(r)) } : null;
    };
    const justBefore = await prisma.exceptionalAccessJustification.count({ where: { workspaceId: workspace.id } });

    const dry = parse(runCli(['--dry-run']));
    check(dry && dry.found === expectedFound && dry.migrated === 0 && dry.skipped === orphansExpected && orphansExpected >= 1,
      `dry-run: encontrados ${dry?.found}/${expectedFound}, migrados ${dry?.migrated}, omitidos ${dry?.skipped}/${orphansExpected} (incluye la fila sin actor)`);
    check(dry && !dry.leaked, 'dry-run: la salida no imprime ningún motivo');
    check(await withReason() === expectedFound && await prisma.exceptionalAccessJustification.count({ where: { workspaceId: workspace.id } }) === justBefore, 'dry-run: no cambia nada en la BD');

    const first = parse(runCli(['--allow-dev-key']));
    check(first && first.found === expectedFound && first.migrated === expectedFound - orphansExpected && first.skipped === orphansExpected && !first.leaked,
      `1.ª ejecución: encontrados ${first?.found}, migrados ${first?.migrated}, omitidos ${first?.skipped}`);
    const migratedRows = await prisma.exceptionalAccessJustification.findMany({ where: { migratedFromAuditLogId: { in: legacy.map((l) => l.id) } } });
    const second = parse(runCli(['--allow-dev-key']));
    check(second && second.found === 0 && second.migrated === 0 && second.skipped === 0, `2.ª ejecución (idempotente): ${JSON.stringify(second && { found: second.found, migrated: second.migrated, skipped: second.skipped })}`);
    const migratedRows2 = await prisma.exceptionalAccessJustification.findMany({ where: { migratedFromAuditLogId: { in: legacy.map((l) => l.id) } } });
    check(migratedRows.length === 2 && migratedRows2.length === 2, `2 registros migrados (el sin actor no crea registro) y la 2.ª ejecución no duplica (${migratedRows.length} → ${migratedRows2.length})`);
    check(await withReason() === 0, 'ninguna metadata de EXCEPTIONAL_CLINICAL_ACCESS conserva `reason`');
    const anyReason = (await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "workspaceId" = $1 AND metadata ? 'reason' AND action LIKE '%EXCEPTIONAL%'`, workspace.id))[0].n;
    check(anyReason === 0, `ningún AuditLog de acceso excepcional del workspace con \`reason\` (${anyReason})`);
    const legacyAfter = await prisma.auditLog.findMany({ where: { id: { in: legacy.map((l) => l.id) } } });
    check(!JSON.stringify(legacyAfter).includes(MARK), 'el texto antiguo ya no está en claro en ninguna fila antigua');
    const orphanAfter = legacyAfter.find((l) => l.id === legacy[2].id);
    check(orphanAfter?.metadata?.reasonDiscarded === true && orphanAfter.metadata.migrated === false, `fila sin actor: reasonDiscarded (${JSON.stringify(orphanAfter?.metadata)})`);
    check(migratedRows.every((r) => r.justification.startsWith('enc:') && !r.justification.includes(MARK) && r.closedAt && r.authSessionId === null && r.reasonCode === 'DATA_INCIDENT'),
      'registros migrados: texto cifrado, DATA_INCIDENT, cerrados y sin sesión');
    // El texto se puede recuperar descifrado por la vía auditada del OWNER.
    const ownerRead = await loginOtherDevice(A.owner, 'owner-h5');
    const migratedOwner = migratedRows.find((r) => r.actorId === A.owner.userId);
    const read = await ownerRead.call(`/exceptional-access/${migratedOwner.id}/justification`, { method: 'POST', body: { purpose: 'INTERNAL_AUDIT' } });
    check(read.status === 200 && read.data?.justification === legacyReasons[0], `OWNER descifra el motivo migrado por la vía auditada (${read.status})`);
    // Y un registro migrado nunca concede acceso.
    const stillDenied = await ownerRead.call(`/patients/${patient.id}/history`);
    check(stillDenied.status === 403, `el registro migrado no concede acceso (historia → ${stillDenied.status})`);
  }

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
