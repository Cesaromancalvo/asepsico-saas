// Smoke test HTTP real de AsePsico. Datos 100 % ficticios.
//
// Variables de entorno:
//   ASEPSICO_API_URL          URL base de la API (por defecto http://localhost:4000/api/v1).
//   ASEPSICO_SMOKE_EMAIL      Cuenta de prueba (por defecto demo@asepsico.es, la del seed).
//   ASEPSICO_SMOKE_PASSWORD   Contraseña de esa cuenta (obligatoria, sin valor por defecto).
//
// Verificación en dos pasos (MFA). La API exige MFA activo a OWNER/ADMIN/THERAPIST para
// cualquier ruta que no sea configurarlo, así que el smoke necesita una sesión con MFA:
//
//   ASEPSICO_SMOKE_TOTP_SECRET  Secreto TOTP (base32) de una cuenta que YA tiene MFA activo.
//                               Si el login pide código, se genera con este secreto. Es el
//                               camino para ejecutar el smoke contra entornos persistentes
//                               (p. ej. el piloto) sin tocar la configuración de la cuenta.
//
//   ASEPSICO_SMOKE_ENROLL_MFA=1 Solo para BD desechables (CI, local recién sembrada). Si la
//                               cuenta NO tiene MFA, el smoke lo activa (mfa/setup + confirm
//                               con la contraseña de la cuenta y un TOTP generado aquí),
//                               renueva el JWT con /auth/refresh y,
//                               al terminar (también si falla a mitad), lo desactiva de nuevo
//                               con mfa/disable (usando un código de recuperación, no el TOTP ya
//                               usado) para dejar la cuenta como estaba. Así el smoke es
//                               repetible sobre la misma BD. Sin esta variable el smoke NUNCA
//                               modifica la configuración de MFA de la cuenta.
//                               Salvaguarda: solo se permite si ASEPSICO_API_URL apunta a
//                               localhost, 127.0.0.1 o ::1. Contra el piloto/producción se
//                               aborta, porque si fallara el disable un profesional real se
//                               quedaría con un MFA de secreto desconocido.
//
//   ASEPSICO_SMOKE_ALLOW_REMOTE_ENROLL=1  Válvula explícita para permitir ENROLL_MFA contra
//                               un host no local (p. ej. un entorno efímero). NO se define en
//                               CI ni debe usarse contra el piloto o producción.
//
//   ASEPSICO_SMOKE_ASSISTANT_EMAIL / ASEPSICO_SMOKE_ASSISTANT_PASSWORD  Cuenta ASSISTANT
//                               opcional del mismo workspace para comprobar el 403 del motivo de
//                               consulta. Sin ellas, esa comprobación se omite con aviso.
//
//   DATABASE_URL                Con ASEPSICO_SMOKE_ENROLL_MFA=1 (BD desechable) es OBLIGATORIA: el
//                               paso «Recepción sin metadatos del proceso clínico» crea con Prisma
//                               dos consultas ficticias propias (OWNER, ASSISTANT y dos THERAPIST;
//                               y otra consulta con un paciente) y comprueba por HTTP lo que ve
//                               recepción (condición 2 de Argos, fix/pacientes-recepcion-sin-proceso).
//                               Sin ENROLL_MFA (piloto) ese paso se omite con aviso. Los datos que
//                               crea se quedan en la BD desechable.
//
//   ASEPSICO_SMOKE_EXPECT_TERMS_428=1  Comprueba el 428 de condiciones nuevas con una cuenta que YA
//                               existe (condición de Argos): tras el login, una ruta protegida
//                               debe responder 428 TERMS_ACCEPTANCE_REQUIRED; la cuenta acepta
//                               las versiones vigentes (POST /legal/terms/accept) y deja de
//                               recibir 428. Para provocarlo de verdad: sembrar la BD SIN
//                               LEGAL_TITULAR_NIF/LEGAL_TITULAR_DOMICILIO y arrancar la API CON
//                               un NIF y un domicilio ficticios pero válidos (p. ej. el DNI de
//                               ejemplo 12345678Z, letra de control correcta, y "Calle Ficticia
//                               1, 00000 Ciudad Inventada"): el texto servido cambia, su hash
//                               también, y la aceptación del seed deja de valer. Nunca datos
//                               reales. Solo en BD desechables: deja evidencia de aceptación.
//
// Limitación: si una ejecución con ENROLL_MFA se interrumpe de forma abrupta (kill -9) antes
// de desactivar el MFA, la cuenta queda con MFA activo y un secreto que nadie conoce. En ese
// caso hay que volver a sembrar la BD (npm run db:seed) o pasar ASEPSICO_SMOKE_TOTP_SECRET.
//
// El script nunca imprime secretos TOTP, códigos, códigos de recuperación ni tokens.
// La sesión viaja en cookies httpOnly y las escrituras llevan la cabecera CSRF.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const API = process.env.ASEPSICO_API_URL || 'http://localhost:4000/api/v1';
const email = process.env.ASEPSICO_SMOKE_EMAIL || 'demo@asepsico.es';
// Sin valor por defecto: el seed ya no usa una contraseña fija (SEED_DEMO_PASSWORD o aleatoria).
const password = process.env.ASEPSICO_SMOKE_PASSWORD || '';
if (!password) throw new Error('Falta ASEPSICO_SMOKE_PASSWORD (la misma que SEED_DEMO_PASSWORD al sembrar, o la que imprimió el seed)');
const presetTotpSecret = process.env.ASEPSICO_SMOKE_TOTP_SECRET || '';
const allowMfaEnrollment = process.env.ASEPSICO_SMOKE_ENROLL_MFA === '1';
const allowRemoteEnrollment = process.env.ASEPSICO_SMOKE_ALLOW_REMOTE_ENROLL === '1';
// Cuenta ASSISTANT opcional del mismo workspace (sin MFA obligatorio). Si se define, el smoke
// comprueba además que un ASSISTANT recibe 403 en GET /patients/:id/consultation-reason y que no
// ve el motivo en las vistas generales. Si no, ese paso se omite y se avisa (no se da por pasado).
const assistantEmail = process.env.ASEPSICO_SMOKE_ASSISTANT_EMAIL || '';
const assistantPassword = process.env.ASEPSICO_SMOKE_ASSISTANT_PASSWORD || '';
const expectTerms428 = process.env.ASEPSICO_SMOKE_EXPECT_TERMS_428 === '1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MFA_REQUIRED_MESSAGE = 'Activa la verificación en dos pasos';

// otplib es dependencia de @asepsico/api; se resuelve desde ese workspace.
const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
async function totpCode(secret) {
  const { generate } = requireFromApi('otplib');
  return generate({ secret });
}

const cookies = new Map();
function cookieHeader(jar = cookies) { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); }
function capture(res, jar = cookies) { const values = res.headers.getSetCookie?.() || []; for (const raw of values) { const [pair] = raw.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); } }
// Petición que devuelve { status, data } sin lanzar: para comprobar respuestas de error (403/404).
async function rawReq(path, { method = 'GET', body, jar = cookies, ip } = {}) { const headers = {}; if (ip) headers['x-forwarded-for'] = ip; if (jar.size) headers.cookie = cookieHeader(jar); if (body !== undefined) headers['content-type'] = 'application/json'; if (!['GET', 'HEAD'].includes(method)) { const csrf = jar.get('csrf_token'); if (csrf) headers['x-csrf-token'] = decodeURIComponent(csrf); } const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); capture(res, jar); const data = await res.json().catch(() => ({})); return { status: res.status, ok: res.ok, data }; }
async function req(path, options = {}) { const { method = 'GET' } = options; const { ok, status, data } = await rawReq(path, options); if (!ok) throw new Error(`${method} ${path}: ${status} ${JSON.stringify(data)}`); return data; }
function assert(value, message) { if (!value) throw new Error(message); }

// Código de recuperación del MFA que activa el propio smoke (solo con ENROLL_MFA). Solo en
// memoria, nunca se imprime. Se usa para desactivarlo al final: reutilizar el TOTP de la
// misma ventana fallaría en cuanto la API tenga protección anti-replay.
let enrolledRecoveryCode = null;

function assertEnrollmentTargetAllowed() {
  const hostname = new URL(API).hostname;
  if (LOCAL_HOSTS.has(hostname) || allowRemoteEnrollment) return;
  throw new Error(`ASEPSICO_SMOKE_ENROLL_MFA=1 solo se permite contra localhost/127.0.0.1/::1 (API: ${hostname}). ` +
    'Contra entornos persistentes usa ASEPSICO_SMOKE_TOTP_SECRET.');
}

// Id del usuario de la sesión del smoke: OWNER/ADMIN deben indicar therapistId al abrir un
// proceso clínico (la API no lo infiere para roles de gestión), así que lo abrimos a su nombre.
let sessionUserId = null;

async function login() {
  const result = await req('/auth/login', { method: 'POST', body: { email, password } });
  sessionUserId = result.user?.id ?? null;
  if (result.mfaRequired) {
    if (!presetTotpSecret) {
      throw new Error('La cuenta de smoke tiene MFA activo y no se ha definido ASEPSICO_SMOKE_TOTP_SECRET. ' +
        'En una BD desechable, vuelve a sembrarla (npm run db:seed) y usa ASEPSICO_SMOKE_ENROLL_MFA=1.');
    }
    const session = await req('/auth/login/mfa', { method: 'POST', body: { pendingToken: result.pendingToken, code: await totpCode(presetTotpSecret) } });
    sessionUserId = session.user?.id ?? null;
    console.log('   sesión iniciada con MFA (secreto proporcionado por entorno)');
    return;
  }
  // Sin MFA: el login deja cookies, pero si el rol exige MFA la API solo permite configurarlo.
  // Lo comprobamos con una lectura inocua (sin datos clínicos), sin replicar aquí la lista de
  // roles del guard: solo el 403 con el mensaje concreto del guard de MFA significa "falta MFA";
  // cualquier otro error se propaga tal cual.
  try {
    await req('/notifications/preferences');
    return;
  } catch (error) {
    const message = String(error.message);
    if (!(/: 403 /.test(message) && message.includes(MFA_REQUIRED_MESSAGE))) throw error;
  }
  if (!allowMfaEnrollment) {
    throw new Error('La API exige MFA a esta cuenta y no lo tiene activo. Define ASEPSICO_SMOKE_TOTP_SECRET ' +
      '(cuenta con MFA) o, SOLO en una BD desechable, ASEPSICO_SMOKE_ENROLL_MFA=1.');
  }
  assertEnrollmentTargetAllowed();
  const setup = await req('/auth/mfa/setup', { method: 'POST' });
  assert(typeof setup.secret === 'string' && setup.secret.length > 0, 'mfa/setup no devolvió secreto');
  const confirmed = await req('/auth/mfa/confirm', { method: 'POST', body: { password, code: await totpCode(setup.secret) } });
  assert(Array.isArray(confirmed.recoveryCodes) && confirmed.recoveryCodes.length > 0, 'mfa/confirm no devolvió códigos de recuperación');
  enrolledRecoveryCode = confirmed.recoveryCodes[0];
  // El JWT emitido en el login lleva mfaEnabled=false; refresh lo reemite con el valor real.
  await req('/auth/refresh', { method: 'POST' });
  console.log('   MFA activado temporalmente para el smoke (se desactivará al terminar)');
}

async function revertEnrollment() {
  if (!enrolledRecoveryCode) return;
  await req('/auth/mfa/disable', { method: 'POST', body: { password, code: enrolledRecoveryCode } });
  enrolledRecoveryCode = null;
  console.log('   MFA temporal desactivado: la cuenta queda como estaba');
}

// Textos ficticios marcados para detectar si el motivo de consulta o el título del proceso
// aparecen donde no deben (vistas generales y panel).
const SMOKE_REASON = 'Motivo ficticio smoke no debe salir en vistas generales';
const SMOKE_PROCESS_TITLE = 'Proceso ficticio smoke sin titulo en vistas generales';

function assertNoClinicalContent(value, where) {
  const json = JSON.stringify(value);
  assert(!json.includes('consultationReason'), `${where} expone consultationReason`);
  assert(!json.includes(SMOKE_REASON), `${where} expone el motivo de consulta`);
  assert(!/enc:v[12]:/.test(json), `${where} expone texto cifrado`);
  assert(!json.includes(SMOKE_PROCESS_TITLE), `${where} expone el título del proceso`);
}

// Acceso clínico por proceso ACTIVO (feat/e1-acceso-clinico): ser OWNER e isClinician no basta.
// Antes de abrir el proceso, la historia del paciente recién creado debe dar 403; después, la
// cuenta demo lo trata y el resto del flujo clínico (historia, objetivos, escalas...) funciona.
async function openClinicalProcess(patient) {
  assert(sessionUserId, 'El login no devolvió user.id para abrir el proceso clínico');
  const before = await rawReq(`/patients/${patient.id}/history`);
  assert(before.status === 403, `Sin proceso activo la historia debería dar 403 y dio ${before.status}`);
  const reasonBefore = await rawReq(`/patients/${patient.id}/consultation-reason`);
  assert(reasonBefore.status === 403, `Sin proceso activo /consultation-reason debería dar 403 y dio ${reasonBefore.status}`);
  assert(!JSON.stringify(reasonBefore.data).includes(SMOKE_REASON), 'El 403 sin proceso filtra el motivo');
  await req('/clinical-processes', { method: 'POST', body: { patientId: patient.id, therapistId: sessionUserId, title: SMOKE_PROCESS_TITLE } });
}

// Regresión de fix/patient-reason-exposure contra la API y la BD reales.
async function checkReasonExposure(patient) {
  // El proceso clínico se abre en el paso 2 (openClinicalProcess): sin él no hay acceso clínico.
  assertNoClinicalContent(patient, 'POST /patients');

  const list = await req(`/patients?q=${encodeURIComponent(patient.lastName)}`);
  assert(list.data?.some(x => x.id === patient.id), 'El paciente de prueba no aparece en GET /patients');
  assertNoClinicalContent(list, 'GET /patients');
  for (const row of list.data) for (const proc of row.clinicalProcesses ?? []) assert(!('title' in proc), 'GET /patients devuelve title de proceso');

  const detail = await req(`/patients/${patient.id}`);
  assertNoClinicalContent(detail, 'GET /patients/:id');
  for (const proc of detail.clinicalProcesses ?? []) assert(!('title' in proc), 'GET /patients/:id devuelve title de proceso');
  if (detail.summary?.activeProcess) assert(!('title' in detail.summary.activeProcess), 'GET /patients/:id devuelve title del proceso activo');

  const reason = await req(`/patients/${patient.id}/consultation-reason`);
  assert(reason.patientId === patient.id && reason.consultationReason === SMOKE_REASON, 'OWNER no recibe el motivo descifrado en /consultation-reason');

  const dashboard = await req('/dashboard');
  const dashboardJson = JSON.stringify(dashboard);
  assert(!/"body"\s*:/.test(dashboardJson), 'El panel devuelve body de mensajes');
  assertNoClinicalContent(dashboard, 'GET /dashboard');

  if (!assistantEmail || !assistantPassword) {
    console.log('   AVISO: sin ASEPSICO_SMOKE_ASSISTANT_EMAIL/PASSWORD se omite el 403 de ASSISTANT (cubierto por test:security)');
    return;
  }
  const assistantJar = new Map();
  const login = await rawReq('/auth/login', { method: 'POST', body: { email: assistantEmail, password: assistantPassword }, jar: assistantJar });
  assert(login.ok && !login.data.mfaRequired, `Login de la cuenta ASSISTANT falló (${login.status})`);
  const denied = await rawReq(`/patients/${patient.id}/consultation-reason`, { jar: assistantJar });
  assert(denied.status === 403, `ASSISTANT debería recibir 403 en /consultation-reason y recibió ${denied.status}`);
  assert(!JSON.stringify(denied.data).includes(SMOKE_REASON), 'El 403 de ASSISTANT filtra el motivo');
  const assistantDetail = await rawReq(`/patients/${patient.id}`, { jar: assistantJar });
  assert(assistantDetail.ok, `ASSISTANT no puede leer la ficha general (${assistantDetail.status})`);
  assertNoClinicalContent(assistantDetail.data, 'GET /patients/:id (ASSISTANT)');
  const write = await rawReq(`/patients/${patient.id}`, { method: 'PATCH', body: { consultationReason: null }, jar: assistantJar });
  assert(write.status === 403, `ASSISTANT debería recibir 403 al escribir consultationReason y recibió ${write.status}`);
  const still = await req(`/patients/${patient.id}/consultation-reason`);
  assert(still.consultationReason === SMOKE_REASON, 'El PATCH rechazado de ASSISTANT modificó el motivo');
  console.log('   ASSISTANT: 403 en /consultation-reason y en la escritura del motivo');
}

// Registro cerrado (solo por invitación): sin token o con uno inventado → 400 neutro, sin cuenta.
// Usa un tarro de cookies aparte para no mezclarse con la sesión del smoke.
async function checkClosedRegistration() {
  const docs = await req('/legal/terms', { jar: new Map() });
  // Piloto demo: condiciones del demo y privacidad para profesionales (sin el contrato art. 28).
  const types = Array.isArray(docs) ? docs.map((d) => d.documentType).sort().join(',') : '';
  assert(types === 'PILOT_TERMS,PRIVACY_PRODUCT' && docs.every((d) => /^[a-f0-9]{64}$/.test(d.textHash)), `GET /legal/terms no devolvió PILOT_TERMS y PRIVACY_PRODUCT con su hash (llegó ${types})`);
  const environment = await req('/environment', { jar: new Map() });
  assert(typeof environment?.demo === 'boolean', 'GET /environment no devolvió { demo: boolean }');
  const acceptedTerms = docs.map(({ documentType, version, textHash }) => ({ documentType, version, textHash }));
  const base = { firstName: 'Intruso', lastName: 'Ficticio', email: `smoke-registro-${Date.now()}@example.test`, password: 'contrasena-ficticia-larga', workspaceName: 'Consulta no invitada', acceptedTerms };
  for (const [label, extra] of [['sin invitación', {}], ['con token inventado', { inviteToken: randomBytes(32).toString('base64url') }]]) {
    const res = await rawReq('/auth/register', { method: 'POST', body: { ...base, ...extra }, jar: new Map() });
    assert(res.status === 400 && res.data?.code === 'REGISTRATION_NOT_ALLOWED', `Registro ${label}: se esperaba 400 REGISTRATION_NOT_ALLOWED y llegó ${res.status} ${JSON.stringify(res.data)}`);
  }
  console.log('   POST /auth/register sin invitación válida → 400 REGISTRATION_NOT_ALLOWED');
}

// Cuenta existente con condiciones nuevas: 428 → acepta → sin 428 (condición de Argos).
async function checkTerms428ThenAccept() {
  assert(LOCAL_HOSTS.has(new URL(API).hostname), 'ASEPSICO_SMOKE_EXPECT_TERMS_428=1 solo contra una API local (deja evidencia de aceptación)');
  const blocked = await rawReq('/notifications/preferences');
  assert(blocked.status === 428 && blocked.data?.code === 'TERMS_ACCEPTANCE_REQUIRED', `Se esperaba 428 TERMS_ACCEPTANCE_REQUIRED y llegó ${blocked.status} ${JSON.stringify(blocked.data)}`);
  assert(Array.isArray(blocked.data.pending) && blocked.data.pending.length > 0 && blocked.data.pending.every((d) => d.text === undefined), 'El 428 no lista lo pendiente o incluye el texto');
  const before = await req('/legal/terms/status');
  assert(before.acceptanceRequired === true, 'GET /legal/terms/status no indica condiciones pendientes');
  const docs = await req('/legal/terms');
  assert(docs.every((d) => d.draft === false && !/\[NIF\]|\[DOMICILIO\]/.test(d.text)), 'Las condiciones servidas siguen en borrador: arranca la API con LEGAL_TITULAR_NIF y LEGAL_TITULAR_DOMICILIO ficticios válidos');
  const acceptedTerms = docs.map(({ documentType, version, textHash }) => ({ documentType, version, textHash }));
  const accepted = await req('/legal/terms/accept', { method: 'POST', body: { acceptedTerms } });
  assert(accepted.acceptanceRequired === false && accepted.pending.length === 0, `Tras aceptar siguen pendientes: ${JSON.stringify(accepted.pending)}`);
  const after = await rawReq('/notifications/preferences');
  assert(after.status === 200, `Tras aceptar se esperaba 200 y llegó ${after.status} ${JSON.stringify(after.data)}`);
  console.log('   cuenta existente: 428 TERMS_ACCEPTANCE_REQUIRED → acepta las versiones vigentes → sin 428');
}

// Cambio de contraseña del profesional (POST /auth/change-password) SIN cambiar nada: una nueva
// demasiado corta → 400 (validación, no cuenta como fallo). Solo en BD desechables (ENROLL_MFA): una
// contraseña actual errónea → 401 CHANGE_PASSWORD_INVALID sin cookies nuevas (cuenta 1 fallo de la
// cuenta, que el disable final pone a cero). La contraseña real nunca se cambia en el smoke.
async function checkChangePasswordGuards() {
  const short = await rawReq('/auth/change-password', { method: 'POST', body: { currentPassword: 'smoke-no-es-la-actual', newPassword: 'corta' } });
  assert(short.status === 400, `change-password con nueva corta debía dar 400 y dio ${short.status}`);
  if (!allowMfaEnrollment) { console.log('   change-password: 400 con nueva corta (la comprobación del 401 solo corre con ENROLL_MFA)'); return; }
  const before = cookies.get('access_token');
  const wrong = await rawReq('/auth/change-password', { method: 'POST', body: { currentPassword: `smoke-incorrecta-${randomBytes(6).toString('hex')}`, newPassword: `Smoke-${randomBytes(12).toString('hex')}`, mfaCode: '000000' } });
  assert(wrong.status === 401 && wrong.data.code === 'CHANGE_PASSWORD_INVALID', `change-password con actual errónea debía dar 401 CHANGE_PASSWORD_INVALID y dio ${wrong.status}`);
  assert(cookies.get('access_token') === before, 'change-password fallido no debe emitir sesión nueva');
  console.log('   change-password: 400 con nueva corta y 401 genérico con actual errónea (sin cambiar nada)');
}

// Recepción (ASSISTANT) sin metadatos del proceso clínico (regla dura 2; condición 2 de Argos para
// fix/pacientes-recepcion-sin-proceso). Solo en BD desechables (ENROLL_MFA): prepara con Prisma una
// consulta ficticia propia (no toca la cuenta demo) y otra consulta con un paciente ajeno.
//  - Paciente A: proceso ACTIVE (T1, modalidad y frecuencia no nulas) + proceso DISCHARGED (T2) con
//    citas propias. Paciente B: solo un proceso DISCHARGED. Paciente X: en otra consulta.
//  - ASSISTANT: activeProcess exactamente {id, therapist:{id,firstName,lastName}, hasActiveProcess}
//    en listado, detalle y PATCH; nada de estado, modalidad, frecuencia, fechas, recuentos ni email
//    del profesional; sin clinicalProcessId en las citas de la ficha ni el id del proceso de alta;
//    agenda, GET /sessions y GET /sessions?patientId= sin la relación clinicalProcess ni
//    clinicalProcessId (solo hasClinicalProcess, correcto con y sin proceso), con la misma
//    comprobación de ocultos que la ficha; 403 en el proceso; 404 en otra consulta.
//  - Control: OWNER sigue recibiendo status, modality y allProcesses.
// Cada actor usa su propia IP (X-Forwarded-For, solo efectiva con TRUST_PROXY=loopback) para no
// compartir el límite de login con la cuenta demo.
// `email` se comprueba solo en los objetos del profesional: la ficha del paciente lleva su propio
// email (null en estos pacientes ficticios), que no es dato del proceso.
const RECEPTION_FORBIDDEN_KEYS = ['modality', 'frequency', 'startedAt', 'processCount', 'allProcesses', '_count'];
function therapistEmails(value, found = []) {
  if (Array.isArray(value)) { for (const item of value) therapistEmails(item, found); return found; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'therapist' && child && typeof child === 'object' && 'email' in child) found.push(child.email);
      therapistEmails(child, found);
    }
  }
  return found;
}

async function checkReceptionProcessView(stamp) {
  if (!allowMfaEnrollment) {
    console.log('   AVISO: sin ASEPSICO_SMOKE_ENROLL_MFA=1 (BD desechable) se omite la vista de recepción (cubierta por test:security)');
    return;
  }
  assert(LOCAL_HOSTS.has(new URL(API).hostname), 'La vista de recepción crea datos con Prisma: solo contra una API local');
  assert(process.env.DATABASE_URL, 'Falta DATABASE_URL (la misma BD desechable que usa la API) para preparar la vista de recepción');
  const { PrismaClient } = requireFromApi('@prisma/client');
  const bcrypt = requireFromApi('bcryptjs');
  const prisma = new PrismaClient();
  try {
    const actorPassword = 'Aa1' + randomBytes(15).toString('base64url');
    const hash = await bcrypt.hash(actorPassword, 10);
    const terms = (await req('/legal/terms', { jar: new Map() })).map(({ documentType, version, textHash }) => ({ documentType, version, textHash }));
    const tag = `Recepcion${stamp}`;
    const workspace = await prisma.workspace.create({ data: { name: `Consulta QA recepción ${stamp}` } });
    const other = await prisma.workspace.create({ data: { name: `Consulta QA ajena ${stamp}` } });
    const users = {};
    for (const [key, role, isClinician, ws] of [['owner', 'OWNER', false, workspace], ['assistant', 'ASSISTANT', false, workspace], ['t1', 'THERAPIST', true, workspace], ['t2', 'THERAPIST', true, workspace], ['ownerx', 'OWNER', true, other]]) {
      const user = await prisma.user.create({ data: { email: `qa-recepcion-${key}-${stamp}@example.test`, passwordHash: hash, firstName: `QA ${key}`, lastName: 'Ficticio' } });
      await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role, isClinician } });
      await prisma.termsAcceptance.createMany({ data: terms.map((t) => ({ workspaceId: ws.id, userId: user.id, ...t, userAgent: 'smoke-live recepción' })) });
      users[key] = user;
    }
    const patient = (ws, firstName) => prisma.patient.create({ data: { workspaceId: ws.id, firstName, lastName: tag } });
    const [pa, pb, px] = [await patient(workspace, 'PacienteA'), await patient(workspace, 'PacienteB'), await patient(other, 'PacienteX')];
    const proc = (patientId, therapistId, status, modality, frequency, ws = workspace) => prisma.clinicalProcess.create({ data: {
      workspaceId: ws.id, patientId, therapistId, title: SMOKE_PROCESS_TITLE, status, modality, frequency,
      ...(status === 'DISCHARGED' ? { endedAt: new Date() } : {}),
    } });
    const discharged = await proc(pa.id, users.t2.id, 'DISCHARGED', 'HYBRID', 'Quincenal ficticia');
    const active = await proc(pa.id, users.t1.id, 'ACTIVE', 'ONLINE', 'Semanal ficticia');
    const dischargedB = await proc(pb.id, users.t2.id, 'DISCHARGED', 'HYBRID', 'Quincenal ficticia');
    const activeX = await proc(px.id, users.ownerx.id, 'ACTIVE', 'ONLINE', 'Semanal ficticia', other);
    const DAY = 24 * 60 * 60 * 1000;
    const session = (patientId, therapistId, clinicalProcessId, days, status) => {
      const startsAt = new Date(Date.now() + days * DAY);
      return prisma.session.create({ data: { workspaceId: workspace.id, patientId, therapistId, clinicalProcessId, startsAt, endsAt: new Date(startsAt.getTime() + 50 * 60 * 1000), status, location: 'Sala ficticia' } });
    };
    await session(pa.id, users.t2.id, discharged.id, -40, 'COMPLETED');
    await session(pa.id, users.t1.id, active.id, -5, 'COMPLETED');
    await session(pa.id, users.t1.id, active.id, 3, 'SCHEDULED');
    await session(pb.id, users.t2.id, dischargedB.id, -60, 'COMPLETED');
    const withoutProcess = await session(pa.id, users.t1.id, null, 5, 'SCHEDULED');
    const hidden = [discharged.id, dischargedB.id, activeX.id, px.id];

    let ipSeq = 0;
    async function actor(key, needsMfa) {
      const jar = new Map();
      const ip = `192.0.2.${(stamp % 200) + (++ipSeq)}`;
      const call = (path, options = {}) => rawReq(path, { ...options, jar, ip });
      const ok = async (path, options = {}) => { const res = await call(path, options); if (!res.ok) throw new Error(`${key} ${options.method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(res.data)}`); return res.data; };
      const login = await ok('/auth/login', { method: 'POST', body: { email: users[key].email, password: actorPassword } });
      assert(!login.mfaRequired && login.user?.id === users[key].id, `Login de ${key} no devolvió su id`);
      if (needsMfa) {
        const setup = await ok('/auth/mfa/setup', { method: 'POST' });
        await ok('/auth/mfa/confirm', { method: 'POST', body: { password: actorPassword, code: await totpCode(setup.secret) } });
        await ok('/auth/refresh', { method: 'POST' });
      }
      return { call, ok };
    }
    const assistant = await actor('assistant', false);
    const owner = await actor('owner', true);

    const expectedActive = { id: active.id, therapist: { id: users.t1.id, firstName: users.t1.firstName, lastName: users.t1.lastName }, hasActiveProcess: true };
    const sameJson = (a, b) => { const norm = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => p.localeCompare(q))) : x)); return norm(a) === norm(b); };
    function assertReception(value, where) {
      const json = JSON.stringify(value);
      for (const key of RECEPTION_FORBIDDEN_KEYS) assert(!json.includes(`"${key}"`), `${where} (ASSISTANT) devuelve la clave ${key}`);
      assert(therapistEmails(value).length === 0, `${where} (ASSISTANT) devuelve el email del profesional`);
      for (const id of hidden) assert(!json.includes(id), `${where} (ASSISTANT) devuelve un id de proceso de alta o de otra consulta`);
      for (const marker of ['HYBRID', 'ONLINE', 'DISCHARGED', 'Quincenal ficticia', 'Semanal ficticia', SMOKE_PROCESS_TITLE, '@example.test']) {
        assert(!json.includes(marker), `${where} (ASSISTANT) expone ${marker}`);
      }
    }
    function assertPatientA(row, where) {
      assert(sameJson(row?.summary?.activeProcess, expectedActive), `${where}: activeProcess de A no es exactamente {id, therapist:{id,firstName,lastName}, hasActiveProcess:true}: ${JSON.stringify(row?.summary?.activeProcess)}`);
      assertReception(row, where);
    }
    function assertDetailA(detail, where) {
      assertPatientA(detail, where);
      assert(!JSON.stringify(detail).includes('"clinicalProcessId"'), `${where} (ASSISTANT) devuelve clinicalProcessId en las citas`);
      assert(Array.isArray(detail.summary.recentSessions) && detail.summary.recentSessions.length === 4, `${where}: se esperaban 4 citas recientes de A y llegaron ${detail.summary.recentSessions?.length}`);
      assert(detail.summary.lastSession && detail.summary.nextSession, `${where}: faltan lastSession o nextSession (la comprobación no sería concluyente)`);
    }

    // ASSISTANT: listado.
    const list = await assistant.ok(`/patients?q=${encodeURIComponent(tag)}`);
    const rowA = list.data?.find((x) => x.id === pa.id);
    const rowB = list.data?.find((x) => x.id === pb.id);
    assert(rowA && rowB, 'GET /patients (ASSISTANT) no devuelve los pacientes A y B');
    assert(!list.data.some((x) => x.id === px.id), 'GET /patients (ASSISTANT) devuelve el paciente de otra consulta');
    assertPatientA(rowA, 'GET /patients fila A');
    assert(rowB.summary && rowB.summary.activeProcess === null, `GET /patients fila B: activeProcess debía ser null y fue ${JSON.stringify(rowB.summary?.activeProcess)}`);
    assertReception(list, 'GET /patients');

    // ASSISTANT: detalle, PATCH inocuo, otra consulta.
    assertDetailA(await assistant.ok(`/patients/${pa.id}`), 'GET /patients/:idA');
    const detailB = await assistant.ok(`/patients/${pb.id}`);
    assert(detailB.summary && detailB.summary.activeProcess === null, `GET /patients/:idB: activeProcess debía ser null y fue ${JSON.stringify(detailB.summary?.activeProcess)}`);
    assertReception(detailB, 'GET /patients/:idB');
    const foreign = await assistant.call(`/patients/${px.id}`);
    assert(foreign.status === 404, `GET /patients/:idOtraConsulta (ASSISTANT) debía dar 404 y dio ${foreign.status}`);
    const patched = await assistant.ok(`/patients/${pa.id}`, { method: 'PATCH', body: { phone: '+34600000099' } });
    assert(patched.phone === '+34600000099', 'PATCH /patients/:idA (ASSISTANT) no devolvió el teléfono nuevo');
    assertDetailA(patched, 'PATCH /patients/:idA');

    // ASSISTANT: agenda del paciente y listado de citas, sin clinicalProcessId (solo hasClinicalProcess).
    function assertReceptionSessions(rows, where) {
      assert(Array.isArray(rows) && rows.length > 0, `${where} (ASSISTANT) no devolvió citas (comprobación no concluyente)`);
      for (const row of rows) {
        assert(!('clinicalProcess' in row), `${where} (ASSISTANT) devuelve la relación clinicalProcess`);
        assert(typeof row.hasClinicalProcess === 'boolean', `${where} (ASSISTANT): falta hasClinicalProcess en la cita ${row.id}`);
        if (row.id === withoutProcess.id) assert(row.hasClinicalProcess === false, `${where} (ASSISTANT): la cita sin proceso llega con hasClinicalProcess=true`);
        else if (row.patientId === pa.id || row.patientId === pb.id) assert(row.hasClinicalProcess === true, `${where} (ASSISTANT): una cita con proceso llega con hasClinicalProcess=false`);
      }
      assert(!JSON.stringify(rows).includes('"clinicalProcessId"'), `${where} (ASSISTANT) devuelve clinicalProcessId`);
    }
    const from = new Date(Date.now() - 90 * DAY).toISOString();
    const to = new Date(Date.now() + 30 * DAY).toISOString();
    const agenda = await assistant.ok(`/sessions/patient/${pa.id}/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    assert(Array.isArray(agenda.data) && agenda.data.length === 4, `Agenda de A (ASSISTANT): se esperaban 4 citas y llegaron ${agenda.data?.length}`);
    assert(agenda.data.some((row) => row.id === withoutProcess.id), 'Agenda de A (ASSISTANT) no incluye la cita sin proceso (comprobación no concluyente)');
    assertReceptionSessions([...agenda.data, agenda.nextSession].filter(Boolean), 'Agenda del paciente');
    assertReception(agenda, 'Agenda del paciente');
    for (const path of ['/sessions?pageSize=100', `/sessions?patientId=${pa.id}`]) {
      const sessions = await assistant.ok(path);
      assertReceptionSessions(sessions.data, `GET ${path}`);
      assertReception(sessions, `GET ${path}`);
    }
    const byPatient = await assistant.ok(`/sessions?patientId=${pa.id}`);
    assert(byPatient.data.length === 4 && byPatient.data.some((row) => row.id === withoutProcess.id), `GET /sessions?patientId=A (ASSISTANT): se esperaban 4 citas con la cita sin proceso y llegaron ${byPatient.data.length}`);
    const processDenied = await assistant.call(`/clinical-processes/${active.id}`);
    assert(processDenied.status === 403, `GET /clinical-processes/:idActivo (ASSISTANT) debía dar 403 y dio ${processDenied.status}`);
    assert(!JSON.stringify(processDenied.data).includes('Semanal ficticia'), 'El 403 del proceso filtra datos del proceso');

    // Control: OWNER conserva la vista completa.
    const ownerList = await owner.ok(`/patients?q=${encodeURIComponent(tag)}`);
    const ownerRowA = ownerList.data?.find((x) => x.id === pa.id);
    assert(ownerRowA?.summary?.activeProcess?.status && ownerRowA.summary.activeProcess.modality && typeof ownerRowA.summary.processCount === 'number', 'GET /patients (OWNER) ya no devuelve status, modality o processCount');
    const ownerDetail = await owner.ok(`/patients/${pa.id}`);
    assert(ownerDetail.summary?.activeProcess?.status === 'ACTIVE' && ownerDetail.summary.activeProcess.modality === 'ONLINE', 'GET /patients/:idA (OWNER) no devuelve status y modality del proceso activo');
    const all = ownerDetail.summary?.allProcesses ?? [];
    assert(all.length === 2 && all.some((p) => p.id === discharged.id && p.status === 'DISCHARGED') && all.every((p) => p.modality), 'GET /patients/:idA (OWNER) no devuelve allProcesses con los dos procesos, su estado y su modalidad');
    const ownerPatched = await owner.ok(`/patients/${pa.id}`, { method: 'PATCH', body: { phone: '+34600000098' } });
    assert(ownerPatched.summary?.allProcesses?.length === 2, 'PATCH /patients/:idA (OWNER) no devuelve allProcesses');
    const ownerAgenda = await owner.ok(`/sessions/patient/${pa.id}/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const ownerWithProcess = ownerAgenda.data?.filter((row) => row.id !== withoutProcess.id) ?? [];
    assert(ownerAgenda.data?.length === 4 && ownerWithProcess.length === 3 && ownerWithProcess.every((row) => row.clinicalProcess?.status && row.clinicalProcess.modality && row.clinicalProcessId === row.clinicalProcess.id), 'Agenda de A (OWNER) ya no devuelve clinicalProcess con status y modality, o clinicalProcessId');
    const ownerSessions = await owner.ok(`/sessions?patientId=${pa.id}`);
    assert(ownerSessions.data?.length === 4 && ownerSessions.data.some((row) => row.clinicalProcessId === discharged.id) && ownerSessions.data.every((row) => !('hasClinicalProcess' in row)), 'GET /sessions?patientId=A (OWNER) ya no devuelve clinicalProcessId (o recibe la vista de recepción)');
    assert(ownerSessions.data.filter((row) => row.id !== withoutProcess.id).every((row) => row.clinicalProcess?.status), 'GET /sessions (OWNER) ya no devuelve clinicalProcess con status');
    console.log('   ASSISTANT: solo {id, therapist, hasActiveProcess} del proceso activo en listado, ficha y PATCH; B → null; otra consulta → 404; agenda y citas sin clinicalProcess ni clinicalProcessId (hasClinicalProcess correcto); proceso → 403. OWNER: vista completa');
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const stamp = Date.now();
  console.log('0/11 Registro cerrado y condiciones vigentes'); await checkClosedRegistration();
  console.log('1/11 Login'); await login();
  if (expectTerms428) await checkTerms428ThenAccept();
  const terms = await req('/legal/terms/status'); assert(terms.acceptanceRequired === false, `La cuenta demo tiene condiciones pendientes: ${JSON.stringify(terms.pending)}`); console.log('   condiciones vigentes aceptadas por el OWNER demo (sin 428)');
  await checkChangePasswordGuards();
  console.log('2/11 Crear paciente y abrir su proceso clínico'); const patient = await req('/patients', { method: 'POST', body: { firstName: 'Prueba', lastName: `Usabilidad ${stamp}`, email: `smoke-${stamp}@example.test`, phone: '+34600000000', consultationReason: SMOKE_REASON } }); assert(patient.id, 'No se devolvió patient.id'); await openClinicalProcess(patient); console.log('   sin proceso: 403 en historia y motivo; proceso clínico abierto a nombre de la cuenta demo');
  console.log('3/11 Guardar y recargar historia'); await req(`/patients/${patient.id}/history`, { method: 'PATCH', body: { reasonForConsultation: 'Prueba automática de persistencia' } }); const history = await req(`/patients/${patient.id}/history`); assert(history.reasonForConsultation === 'Prueba automática de persistencia', 'La historia no persistió');
  console.log('4/11 Guardar objetivo y tarea'); const goal = await req(`/patients/${patient.id}/goals`, { method: 'POST', body: { title: 'Objetivo smoke test', priority: 2 } }); const task = await req(`/patients/${patient.id}/tasks`, { method: 'POST', body: { title: 'Tarea smoke test', therapyGoalId: goal.id } }); const tasks = await req(`/patients/${patient.id}/tasks`); assert(tasks.some(x => x.id === task.id), 'La tarea no apareció al recargar');
  console.log('5/11 Guardar escala'); const assessment = await req(`/patients/${patient.id}/assessments`, { method: 'POST', body: { scaleCode: 'PHQ9', answers: [0, 0, 0, 0, 0, 0, 0, 0, 0] } }); const assessments = await req(`/patients/${patient.id}/assessments`); assert(assessments.some(x => x.id === assessment.id), 'La escala no persistió');
  console.log('6/11 Guardar documento, consentimiento e informe'); await req(`/patients/${patient.id}/documents`, { method: 'POST', body: { title: 'Documento smoke', type: 'ADMINISTRATIVE', fileName: 'smoke.pdf', mimeType: 'application/pdf', storageKey: `smoke/${stamp}` } }); await req(`/patients/${patient.id}/consents`, { method: 'POST', body: { title: 'Consentimiento smoke', type: 'DATA_PROCESSING', status: 'PENDING' } }); await req(`/patients/${patient.id}/reports`, { method: 'POST', body: { title: 'Informe smoke', type: 'EVOLUTION', status: 'DRAFT', content: 'Contenido de comprobación automática.' } }); assert((await req(`/patients/${patient.id}/documents`)).length > 0, 'Documento no persistió'); assert((await req(`/patients/${patient.id}/consents`)).length > 0, 'Consentimiento no persistió'); assert((await req(`/patients/${patient.id}/reports`)).length > 0, 'Informe no persistió');
  console.log('7/11 Guardar preferencias'); await req('/notifications/preferences', { method: 'PATCH', body: { appointmentReminders: true, taskReminders: true, consentReminders: false, invoiceReminders: true, emailEnabled: false, smsEnabled: false, reminderHoursBefore: 24 } }); const pref = await req('/notifications/preferences'); assert(pref.reminderHoursBefore === 24, 'Preferencias no persistieron');
  console.log('8/11 Comprobar timeline'); const timeline = await req(`/patients/${patient.id}/timeline`); assert(Array.isArray(timeline), 'Timeline no disponible');
  console.log('9/11 Motivo de consulta y títulos de proceso fuera de las vistas generales y del panel'); await checkReasonExposure(patient);
  console.log('9b/11 Recepción (ASSISTANT) sin metadatos del proceso clínico; OWNER como control'); await checkReceptionProcessView(stamp);
  // Portal: un mismo paciente admite cuenta propia y de tutor (regresión del índice único
  // PatientPortalAccount_patientId_key, migración 20260925000000) y el cambio de modo revoca las
  // cuentas incompatibles. Contraseña aleatoria por ejecución (repo público), que cumple la política
  // del DTO (mayúscula, minúscula y número). Pase lo que pase, el finally desactiva las cuentas y
  // archiva el paciente: el smoke no deja accesos vivos.
  const portalPassword = 'Aa1' + randomBytes(18).toString('base64url');
  let cleanupError = null;
  try {
    console.log('10/11 Habilitar portal del paciente y de un tutor (modo SHARED, dos cuentas)');
    await req(`/patients/${patient.id}`, { method: 'PATCH', body: { portalAccessMode: 'SHARED' } });
    const ownAccount = await req(`/patients/${patient.id}/portal-account`, { method: 'POST', body: { email: `smoke-portal-${stamp}@example.test`, temporaryPassword: portalPassword, accessorType: 'PATIENT' } });
    const guardianAccount = await req(`/patients/${patient.id}/portal-account`, { method: 'POST', body: { email: `smoke-tutor-${stamp}@example.test`, temporaryPassword: portalPassword, accessorType: 'GUARDIAN', guardianName: 'Tutor Ficticio', guardianRelationship: 'padre' } });
    assert(ownAccount.id && guardianAccount.id && ownAccount.id !== guardianAccount.id, 'No se crearon dos cuentas de portal distintas');
    const portalAccounts = await req(`/patients/${patient.id}/portal-accounts`);
    assert(portalAccounts.length === 2, `Se esperaban 2 cuentas de portal y hay ${portalAccounts.length}`);
    assert(portalAccounts.some(x => x.accessorType === 'PATIENT') && portalAccounts.some(x => x.accessorType === 'GUARDIAN'), 'Faltan la cuenta del paciente o la del tutor');

    console.log('11/11 Pasar a PATIENT_ONLY (revoca al tutor), revocar portal y archivar paciente de prueba');
    await req(`/patients/${patient.id}`, { method: 'PATCH', body: { portalAccessMode: 'PATIENT_ONLY' } });
    const afterMode = await req(`/patients/${patient.id}/portal-accounts`);
    assert(afterMode.find(x => x.accessorType === 'GUARDIAN')?.isActive === false && afterMode.find(x => x.accessorType === 'PATIENT')?.isActive === true, 'Pasar a PATIENT_ONLY no revocó solo la cuenta del tutor');
  } finally {
    // Limpieza también si algo falla a mitad. Un error aquí no tapa el original: se registra y,
    // si los pasos fueron bien, se relanza después.
    try { await req(`/patients/${patient.id}/portal-account`, { method: 'DELETE' }); } catch (error) { if (!/: 404 /.test(String(error.message))) cleanupError = error; }
    try {
      const left = await req(`/patients/${patient.id}/portal-accounts`);
      if (left.some(x => x.isActive !== false)) cleanupError ??= new Error('Quedan cuentas de portal activas tras desactivarlas');
    } catch (error) { cleanupError ??= error; }
    try { await req(`/patients/${patient.id}`, { method: 'DELETE' }); } catch (error) { cleanupError ??= error; }
    if (cleanupError) console.error(`   limpieza del portal: ${cleanupError.message}`);
  }
  if (cleanupError) throw cleanupError;
  console.log('OK: flujo crítico guardado y recargado correctamente.');
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`FALLO: ${error.message}`);
} finally {
  try {
    await revertEnrollment();
  } catch (error) {
    failed = true;
    console.error(`FALLO al desactivar el MFA temporal: ${error.message}. Vuelve a sembrar la BD (npm run db:seed).`);
  }
}
if (failed) process.exitCode = 1;
