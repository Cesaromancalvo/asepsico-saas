// Siembra de datos ficticios para el recorrido manual de las pantallas del acceso clínico
// (feat/e1-web). SOLO para BD desechables y API local.
//
// Crea un workspace "Consulta QA Web" con: OWNER no clínico, ADMIN no clínico, dos THERAPIST y un
// ASSISTANT; tres pacientes con un proceso ACTIVO (T1), uno PAUSED (T2) y uno CLOSED (T1), sesiones
// con notas y una conversación con mensajes. Activa MFA por la API para los roles que lo exigen.
//
// Escribe en QA_OUT (fichero JSON, fuera del repo) los correos, ids y secretos TOTP de prueba para
// poder iniciar sesión en el navegador. Nunca imprime secretos ni contraseñas por consola.
// Variables: ASEPSICO_API_URL, DATABASE_URL, QA_OUT.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const API = process.env.ASEPSICO_API_URL || 'http://127.0.0.1:4000/api/v1';
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(API).hostname)) throw new Error('Solo contra una API local');
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
if (!process.env.QA_OUT) throw new Error('Falta QA_OUT (ruta del JSON de salida, fuera del repo)');

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { generate } = requireFromApi('otplib');
const bcrypt = requireFromApi('bcryptjs');
const { PrismaClient } = requireFromApi('@prisma/client');
const prisma = new PrismaClient();

const stamp = Date.now();
const password = 'Qa1' + randomBytes(15).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ipSeq = 0;
function client(name) {
  const cookies = new Map();
  const ip = `203.0.113.${++ipSeq}`;
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
    if (res.status >= 300) throw new Error(`${name} ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return data;
  }
  return { name, call };
}

async function main() {
  const hash = await bcrypt.hash(password, 10);
  const workspace = await prisma.workspace.create({ data: { name: `Consulta QA Web ${stamp}` } });
  const defs = {
    owner: { role: 'OWNER', isClinician: false, mfa: true, first: 'Olga' },
    admin: { role: 'ADMIN', isClinician: false, mfa: true, first: 'Adrián' },
    t1: { role: 'THERAPIST', isClinician: true, mfa: true, first: 'Teresa' },
    t2: { role: 'THERAPIST', isClinician: true, mfa: true, first: 'Tomás' },
    assistant: { role: 'ASSISTANT', isClinician: false, mfa: false, first: 'Asun' },
  };
  const A = {};
  const out = { workspaceId: workspace.id, password, users: {} };
  for (const [key, def] of Object.entries(defs)) {
    const email = `qa-web-${key}-${stamp}@example.test`;
    const user = await prisma.user.create({ data: { email, passwordHash: hash, firstName: def.first, lastName: 'Ficticio QA' } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: def.role, isClinician: def.isClinician } });
    const c = client(key);
    await c.call('/auth/login', { method: 'POST', body: { email, password } });
    let secret = null;
    if (def.mfa) {
      const setup = await c.call('/auth/mfa/setup', { method: 'POST' });
      secret = setup.secret;
      await c.call('/auth/mfa/confirm', { method: 'POST', body: { password, code: await generate({ secret }) } });
      await c.call('/auth/refresh', { method: 'POST' });
    }
    A[key] = c;
    out.users[key] = { email, userId: user.id, role: def.role, totpSecret: secret };
  }

  const slot = (days, hour) => { const s = new Date(); s.setDate(s.getDate() + days); s.setHours(hour, 0, 0, 0); return { startsAt: s.toISOString(), endsAt: new Date(s.getTime() + 50 * 60_000).toISOString() }; };

  // P1: proceso ACTIVO de T1, sesión con notas y conversación con mensajes.
  const p1 = await A.t1.call('/patients', { method: 'POST', body: { firstName: 'Lucía', lastName: 'Activa Ficticia', consultationReason: 'QAMOTIVO-P1 ansiedad ficticia' } });
  const cp1 = await A.t1.call('/clinical-processes', { method: 'POST', body: { patientId: p1.id, title: 'QAPROC-P1 proceso activo', internalNotes: 'QANOTAINT-P1 nota interna' } });
  await A.t1.call(`/patients/${p1.id}/history`, { method: 'PATCH', body: { reasonForConsultation: 'QAHIST-P1 historia ficticia' } });
  const s1 = await A.t1.call('/sessions', { method: 'POST', body: { patientId: p1.id, clinicalProcessId: cp1.id, ...slot(2, 10), notes: 'QANOTASES-P1 nota de sesión' } });
  const conv1 = await A.t1.call(`/patients/${p1.id}/conversation`, { method: 'POST' });
  await A.t1.call(`/messages/${conv1.id}`, { method: 'POST', body: { body: 'QAMSG-P1 primer mensaje ficticio' } });
  await A.t1.call(`/messages/${conv1.id}`, { method: 'POST', body: { body: 'QAMSG-P1 segundo mensaje ficticio' } });

  // P2: proceso PAUSED de T2.
  const p2 = await A.t2.call('/patients', { method: 'POST', body: { firstName: 'Mario', lastName: 'Pausado Ficticio', consultationReason: 'QAMOTIVO-P2 duelo ficticio' } });
  const cp2 = await A.t2.call('/clinical-processes', { method: 'POST', body: { patientId: p2.id, title: 'QAPROC-P2 proceso pausado', internalNotes: 'QANOTAINT-P2 nota interna' } });
  const s2 = await A.t2.call('/sessions', { method: 'POST', body: { patientId: p2.id, clinicalProcessId: cp2.id, ...slot(3, 11), notes: 'QANOTASES-P2 nota de sesión' } });
  const conv2 = await A.t2.call(`/patients/${p2.id}/conversation`, { method: 'POST' });
  await A.t2.call(`/messages/${conv2.id}`, { method: 'POST', body: { body: 'QAMSG-P2 mensaje ficticio' } });
  await sleep(30);
  await A.t2.call(`/clinical-processes/${cp2.id}/status`, { method: 'PATCH', body: { status: 'PAUSED' } });

  // P3: proceso CLOSED de T1.
  const p3 = await A.t1.call('/patients', { method: 'POST', body: { firstName: 'Nuria', lastName: 'Cerrada Ficticia', consultationReason: 'QAMOTIVO-P3 insomnio ficticio' } });
  const cp3 = await A.t1.call('/clinical-processes', { method: 'POST', body: { patientId: p3.id, title: 'QAPROC-P3 proceso cerrado' } });
  const s3 = await A.t1.call('/sessions', { method: 'POST', body: { patientId: p3.id, clinicalProcessId: cp3.id, ...slot(4, 12), notes: 'QANOTASES-P3 nota de sesión' } });
  await sleep(30);
  await A.t1.call(`/clinical-processes/${cp3.id}/status`, { method: 'PATCH', body: { status: 'CLOSED' } });

  Object.assign(out, {
    patients: { p1: p1.id, p2: p2.id, p3: p3.id },
    processes: { active: cp1.id, paused: cp2.id, closed: cp3.id },
    sessions: { s1: s1.id, s2: s2.id, s3: s3.id },
    conversations: { c1: conv1.id, c2: conv2.id },
  });
  writeFileSync(process.env.QA_OUT, JSON.stringify(out, null, 2), { mode: 0o600 });
  console.log(`Sembrado workspace ${workspace.id}: 5 miembros, 3 pacientes (ACTIVE/PAUSED/CLOSED), 3 sesiones, 2 conversaciones.`);
}

try { await main(); } catch (e) { process.exitCode = 1; console.error(`FALLO: ${e.message}`); } finally { await prisma.$disconnect(); }
