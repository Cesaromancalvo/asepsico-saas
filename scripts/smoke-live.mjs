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
//                               con mfa/disable para dejar la cuenta como estaba. Así el smoke
//                               es repetible sobre la misma BD. Sin esta variable el smoke
//                               NUNCA modifica la configuración de MFA de la cuenta.
//
// Limitación: si una ejecución con ENROLL_MFA se interrumpe de forma abrupta (kill -9) antes
// de desactivar el MFA, la cuenta queda con MFA activo y un secreto que nadie conoce. En ese
// caso hay que volver a sembrar la BD (npm run db:seed) o pasar ASEPSICO_SMOKE_TOTP_SECRET.
//
// El script nunca imprime secretos TOTP, códigos, códigos de recuperación ni tokens.
// La sesión viaja en cookies httpOnly y las escrituras llevan la cabecera CSRF.
import { createRequire } from 'node:module';

const API = process.env.ASEPSICO_API_URL || 'http://localhost:4000/api/v1';
const email = process.env.ASEPSICO_SMOKE_EMAIL || 'demo@asepsico.es';
const password = process.env.ASEPSICO_SMOKE_PASSWORD || 'AsePsico2026!';
const presetTotpSecret = process.env.ASEPSICO_SMOKE_TOTP_SECRET || '';
const allowMfaEnrollment = process.env.ASEPSICO_SMOKE_ENROLL_MFA === '1';

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

// Secreto del MFA que activa el propio smoke (solo con ENROLL_MFA). Solo en memoria.
let enrolledSecret = null;

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
  // Lo comprobamos con una lectura inocua (sin datos clínicos) para no replicar aquí la
  // lista de roles del guard: si responde 403, hace falta MFA.
  try {
    await req('/notifications/preferences');
    return;
  } catch (error) {
    if (!/: 403 /.test(String(error.message))) throw error;
  }
  if (!allowMfaEnrollment) {
    throw new Error('La API exige MFA a esta cuenta y no lo tiene activo. Define ASEPSICO_SMOKE_TOTP_SECRET ' +
      '(cuenta con MFA) o, SOLO en una BD desechable, ASEPSICO_SMOKE_ENROLL_MFA=1.');
  }
  const setup = await req('/auth/mfa/setup', { method: 'POST' });
  assert(typeof setup.secret === 'string' && setup.secret.length > 0, 'mfa/setup no devolvió secreto');
  await req('/auth/mfa/confirm', { method: 'POST', body: { code: await totpCode(setup.secret) } });
  enrolledSecret = setup.secret;
  // El JWT emitido en el login lleva mfaEnabled=false; refresh lo reemite con el valor real.
  await req('/auth/refresh', { method: 'POST' });
  console.log('   MFA activado temporalmente para el smoke (se desactivará al terminar)');
}

async function revertEnrollment() {
  if (!enrolledSecret) return;
  await req('/auth/mfa/disable', { method: 'POST', body: { password, code: await totpCode(enrolledSecret) } });
  enrolledSecret = null;
  console.log('   MFA temporal desactivado: la cuenta queda como estaba');
}

async function main() {
  const stamp = Date.now();
  console.log('1/9 Login'); await login();
  console.log('2/9 Crear paciente'); const patient = await req('/patients', { method: 'POST', body: { firstName: 'Prueba', lastName: `Usabilidad ${stamp}`, email: `smoke-${stamp}@example.test`, phone: '+34600000000' } }); assert(patient.id, 'No se devolvió patient.id');
  console.log('3/9 Guardar y recargar historia'); await req(`/patients/${patient.id}/history`, { method: 'PATCH', body: { reasonForConsultation: 'Prueba automática de persistencia' } }); const history = await req(`/patients/${patient.id}/history`); assert(history.reasonForConsultation === 'Prueba automática de persistencia', 'La historia no persistió');
  console.log('4/9 Guardar objetivo y tarea'); const goal = await req(`/patients/${patient.id}/goals`, { method: 'POST', body: { title: 'Objetivo smoke test', priority: 2 } }); const task = await req(`/patients/${patient.id}/tasks`, { method: 'POST', body: { title: 'Tarea smoke test', therapyGoalId: goal.id } }); const tasks = await req(`/patients/${patient.id}/tasks`); assert(tasks.some(x => x.id === task.id), 'La tarea no apareció al recargar');
  console.log('5/9 Guardar escala'); const assessment = await req(`/patients/${patient.id}/assessments`, { method: 'POST', body: { scaleCode: 'PHQ9', answers: [0, 0, 0, 0, 0, 0, 0, 0, 0] } }); const assessments = await req(`/patients/${patient.id}/assessments`); assert(assessments.some(x => x.id === assessment.id), 'La escala no persistió');
  console.log('6/9 Guardar documento, consentimiento e informe'); await req(`/patients/${patient.id}/documents`, { method: 'POST', body: { title: 'Documento smoke', type: 'ADMINISTRATIVE', fileName: 'smoke.pdf', mimeType: 'application/pdf', storageKey: `smoke/${stamp}` } }); await req(`/patients/${patient.id}/consents`, { method: 'POST', body: { title: 'Consentimiento smoke', type: 'DATA_PROCESSING', status: 'PENDING' } }); await req(`/patients/${patient.id}/reports`, { method: 'POST', body: { title: 'Informe smoke', type: 'EVOLUTION', status: 'DRAFT', content: 'Contenido de comprobación automática.' } }); assert((await req(`/patients/${patient.id}/documents`)).length > 0, 'Documento no persistió'); assert((await req(`/patients/${patient.id}/consents`)).length > 0, 'Consentimiento no persistió'); assert((await req(`/patients/${patient.id}/reports`)).length > 0, 'Informe no persistió');
  console.log('7/9 Guardar preferencias'); await req('/notifications/preferences', { method: 'PATCH', body: { appointmentReminders: true, taskReminders: true, consentReminders: false, invoiceReminders: true, emailEnabled: false, smsEnabled: false, reminderHoursBefore: 24 } }); const pref = await req('/notifications/preferences'); assert(pref.reminderHoursBefore === 24, 'Preferencias no persistieron');
  console.log('8/9 Comprobar timeline'); const timeline = await req(`/patients/${patient.id}/timeline`); assert(Array.isArray(timeline), 'Timeline no disponible');
  console.log('9/9 Archivar paciente de prueba'); await req(`/patients/${patient.id}`, { method: 'DELETE' });
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
