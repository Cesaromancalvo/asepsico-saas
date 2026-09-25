// Smoke test HTTP real de AsePsico. Datos 100 % ficticios.
//
// Variables de entorno:
//   ASEPSICO_API_URL          URL base de la API (por defecto http://localhost:4000/api/v1).
//   ASEPSICO_SMOKE_EMAIL      Cuenta de prueba (por defecto demo@asepsico.es, la del seed).
//   ASEPSICO_SMOKE_PASSWORD   Contraseña de esa cuenta.
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
//                               con un TOTP generado aquí), renueva el JWT con /auth/refresh y,
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
const password = process.env.ASEPSICO_SMOKE_PASSWORD || 'AsePsico2026!';
const presetTotpSecret = process.env.ASEPSICO_SMOKE_TOTP_SECRET || '';
const allowMfaEnrollment = process.env.ASEPSICO_SMOKE_ENROLL_MFA === '1';
const allowRemoteEnrollment = process.env.ASEPSICO_SMOKE_ALLOW_REMOTE_ENROLL === '1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MFA_REQUIRED_MESSAGE = 'Activa la verificación en dos pasos';

// otplib es dependencia de @asepsico/api; se resuelve desde ese workspace.
const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
async function totpCode(secret) {
  const { generate } = requireFromApi('otplib');
  return generate({ secret });
}

const cookies = new Map();
function cookieHeader() { return [...cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
function capture(res) { const values = res.headers.getSetCookie?.() || []; for (const raw of values) { const [pair] = raw.split(';'); const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); } }
async function req(path, { method = 'GET', body } = {}) { const headers = {}; if (cookies.size) headers.cookie = cookieHeader(); if (body !== undefined) headers['content-type'] = 'application/json'; if (!['GET', 'HEAD'].includes(method)) { const csrf = cookies.get('csrf_token'); if (csrf) headers['x-csrf-token'] = decodeURIComponent(csrf); } const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); capture(res); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`); return data; }
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

async function login() {
  const result = await req('/auth/login', { method: 'POST', body: { email, password } });
  if (result.mfaRequired) {
    if (!presetTotpSecret) {
      throw new Error('La cuenta de smoke tiene MFA activo y no se ha definido ASEPSICO_SMOKE_TOTP_SECRET. ' +
        'En una BD desechable, vuelve a sembrarla (npm run db:seed) y usa ASEPSICO_SMOKE_ENROLL_MFA=1.');
    }
    await req('/auth/login/mfa', { method: 'POST', body: { pendingToken: result.pendingToken, code: await totpCode(presetTotpSecret) } });
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
  const confirmed = await req('/auth/mfa/confirm', { method: 'POST', body: { code: await totpCode(setup.secret) } });
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

async function main() {
  const stamp = Date.now();
  console.log('1/10 Login'); await login();
  console.log('2/10 Crear paciente'); const patient = await req('/patients', { method: 'POST', body: { firstName: 'Prueba', lastName: `Usabilidad ${stamp}`, email: `smoke-${stamp}@example.test`, phone: '+34600000000' } }); assert(patient.id, 'No se devolvió patient.id');
  console.log('3/10 Guardar y recargar historia'); await req(`/patients/${patient.id}/history`, { method: 'PATCH', body: { reasonForConsultation: 'Prueba automática de persistencia' } }); const history = await req(`/patients/${patient.id}/history`); assert(history.reasonForConsultation === 'Prueba automática de persistencia', 'La historia no persistió');
  console.log('4/10 Guardar objetivo y tarea'); const goal = await req(`/patients/${patient.id}/goals`, { method: 'POST', body: { title: 'Objetivo smoke test', priority: 2 } }); const task = await req(`/patients/${patient.id}/tasks`, { method: 'POST', body: { title: 'Tarea smoke test', therapyGoalId: goal.id } }); const tasks = await req(`/patients/${patient.id}/tasks`); assert(tasks.some(x => x.id === task.id), 'La tarea no apareció al recargar');
  console.log('5/10 Guardar escala'); const assessment = await req(`/patients/${patient.id}/assessments`, { method: 'POST', body: { scaleCode: 'PHQ9', answers: [0, 0, 0, 0, 0, 0, 0, 0, 0] } }); const assessments = await req(`/patients/${patient.id}/assessments`); assert(assessments.some(x => x.id === assessment.id), 'La escala no persistió');
  console.log('6/10 Guardar documento, consentimiento e informe'); await req(`/patients/${patient.id}/documents`, { method: 'POST', body: { title: 'Documento smoke', type: 'ADMINISTRATIVE', fileName: 'smoke.pdf', mimeType: 'application/pdf', storageKey: `smoke/${stamp}` } }); await req(`/patients/${patient.id}/consents`, { method: 'POST', body: { title: 'Consentimiento smoke', type: 'DATA_PROCESSING', status: 'PENDING' } }); await req(`/patients/${patient.id}/reports`, { method: 'POST', body: { title: 'Informe smoke', type: 'EVOLUTION', status: 'DRAFT', content: 'Contenido de comprobación automática.' } }); assert((await req(`/patients/${patient.id}/documents`)).length > 0, 'Documento no persistió'); assert((await req(`/patients/${patient.id}/consents`)).length > 0, 'Consentimiento no persistió'); assert((await req(`/patients/${patient.id}/reports`)).length > 0, 'Informe no persistió');
  console.log('7/10 Guardar preferencias'); await req('/notifications/preferences', { method: 'PATCH', body: { appointmentReminders: true, taskReminders: true, consentReminders: false, invoiceReminders: true, emailEnabled: false, smsEnabled: false, reminderHoursBefore: 24 } }); const pref = await req('/notifications/preferences'); assert(pref.reminderHoursBefore === 24, 'Preferencias no persistieron');
  console.log('8/10 Comprobar timeline'); const timeline = await req(`/patients/${patient.id}/timeline`); assert(Array.isArray(timeline), 'Timeline no disponible');
  // Portal: un mismo paciente admite cuenta propia y de tutor (regresión del índice único
  // PatientPortalAccount_patientId_key, migración 20260925000000) y el cambio de modo revoca las
  // cuentas incompatibles. Contraseña aleatoria por ejecución (repo público), que cumple la política
  // del DTO (mayúscula, minúscula y número). Pase lo que pase, el finally desactiva las cuentas y
  // archiva el paciente: el smoke no deja accesos vivos.
  const portalPassword = 'Aa1' + randomBytes(18).toString('base64url');
  let cleanupError = null;
  try {
    console.log('9/10 Habilitar portal del paciente y de un tutor (modo SHARED, dos cuentas)');
    await req(`/patients/${patient.id}`, { method: 'PATCH', body: { portalAccessMode: 'SHARED' } });
    const ownAccount = await req(`/patients/${patient.id}/portal-account`, { method: 'POST', body: { email: `smoke-portal-${stamp}@example.test`, temporaryPassword: portalPassword, accessorType: 'PATIENT' } });
    const guardianAccount = await req(`/patients/${patient.id}/portal-account`, { method: 'POST', body: { email: `smoke-tutor-${stamp}@example.test`, temporaryPassword: portalPassword, accessorType: 'GUARDIAN', guardianName: 'Tutor Ficticio', guardianRelationship: 'padre' } });
    assert(ownAccount.id && guardianAccount.id && ownAccount.id !== guardianAccount.id, 'No se crearon dos cuentas de portal distintas');
    const portalAccounts = await req(`/patients/${patient.id}/portal-accounts`);
    assert(portalAccounts.length === 2, `Se esperaban 2 cuentas de portal y hay ${portalAccounts.length}`);
    assert(portalAccounts.some(x => x.accessorType === 'PATIENT') && portalAccounts.some(x => x.accessorType === 'GUARDIAN'), 'Faltan la cuenta del paciente o la del tutor');

    console.log('10/10 Pasar a PATIENT_ONLY (revoca al tutor), revocar portal y archivar paciente de prueba');
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
