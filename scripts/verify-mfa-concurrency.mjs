// Verificación contra PostgreSQL real del límite de intentos de MFA por cuenta ante
// peticiones SIMULTÁNEAS (hallazgo de Argos). Datos 100 % ficticios.
//
// SOLO para BD desechables: activa el MFA en la cuenta de prueba, lanza una ráfaga de códigos
// incorrectos (la cuenta queda en espera ~1 min) y al final lo desactiva con un código de
// recuperación para dejar la cuenta como estaba.
//
// Requisitos:
//   - API arrancada con NODE_ENV=production (trust proxy) para que X-Forwarded-For simule
//     IPs distintas y el throttle por IP no enmascare el límite por cuenta.
//   - DATABASE_URL de la misma BD, para leer el contador y la espera del usuario.
//
// Variables: ASEPSICO_API_URL, ASEPSICO_SMOKE_EMAIL, ASEPSICO_SMOKE_PASSWORD, DATABASE_URL,
//            MFA_BURST (por defecto 20).
// Nunca imprime secretos TOTP, códigos, códigos de recuperación ni tokens.
import { createRequire } from 'node:module';

const API = process.env.ASEPSICO_API_URL || 'http://127.0.0.1:4000/api/v1';
const email = process.env.ASEPSICO_SMOKE_EMAIL || 'demo@asepsico.es';
const password = process.env.ASEPSICO_SMOKE_PASSWORD || 'AsePsico2026!';
const BURST = Number(process.env.MFA_BURST || 20);
const MAX_EVALUATED_PER_TOKEN = 5; // MFA_PENDING_TOKEN_MAX_FAILURES
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

if (!LOCAL_HOSTS.has(new URL(API).hostname)) throw new Error('Solo contra una API local sobre una BD desechable');
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL (la misma BD desechable que usa la API)');

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { generate } = requireFromApi('otplib');
const { PrismaClient } = requireFromApi('@prisma/client');
const prisma = new PrismaClient();

let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

function jar() {
  const cookies = new Map();
  return async function req(path, { method = 'GET', body } = {}) {
    const headers = { 'x-forwarded-for': nextIp() };
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const csrf = cookies.get('csrf_token');
    if (method !== 'GET' && csrf) headers['x-csrf-token'] = decodeURIComponent(csrf);
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const raw of res.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
}

function expectStatus(res, status, what) {
  if (res.status !== status) throw new Error(`${what}: esperaba ${status} y llegó ${res.status} ${JSON.stringify(res.data?.message)}`);
  return res.data;
}

async function wrongCode(secret) {
  const epoch = Math.floor(Date.now() / 1000);
  const valid = new Set(await Promise.all([-30, 0, 30].map((d) => generate({ secret, epoch: epoch + d }))));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

const user = () => prisma.user.findUnique({
  where: { email }, select: { mfaFailedAttempts: true, mfaLockedUntil: true, totpEnabled: true },
});

let recoveryCodes = null;
let failed = false;
try {
  // 1. Activar MFA en la cuenta de prueba (sin MFA previo).
  const staff = jar();
  expectStatus(await staff('/auth/login', { method: 'POST', body: { email, password } }), 200, 'login inicial');
  const setup = expectStatus(await staff('/auth/mfa/setup', { method: 'POST' }), 201, 'mfa/setup');
  const confirmed = expectStatus(
    await staff('/auth/mfa/confirm', { method: 'POST', body: { password, code: await generate({ secret: setup.secret }) } }),
    201, 'mfa/confirm');
  recoveryCodes = confirmed.recoveryCodes;
  console.log('1. MFA activado en la cuenta de prueba');

  // 2. Ráfaga: BURST peticiones simultáneas, mismo pendingToken, IPs distintas, código incorrecto.
  const pending = expectStatus(await jar()('/auth/login', { method: 'POST', body: { email, password } }), 200, 'login con MFA');
  const bad = await wrongCode(setup.secret);
  const burst = await Promise.all(Array.from({ length: BURST }, () =>
    jar()('/auth/login/mfa', { method: 'POST', body: { pendingToken: pending.pendingToken, code: bad } })));
  const tally = {};
  for (const r of burst) {
    const key = `${r.status} ${r.data?.message}`;
    tally[key] = (tally[key] || 0) + 1;
  }
  const evaluated = burst.filter((r) => r.status === 401 && r.data?.message === 'Código no válido').length;
  const after = await user();
  console.log(`2. Ráfaga de ${BURST} login/mfa simultáneos:`);
  for (const [k, v] of Object.entries(tally)) console.log(`     ${v} × ${k}`);
  console.log(`   códigos evaluados: ${evaluated} (máximo permitido ${MAX_EVALUATED_PER_TOKEN})`);
  console.log(`   BD: mfaFailedAttempts=${after.mfaFailedAttempts}, mfaLockedUntil=${after.mfaLockedUntil?.toISOString() ?? 'null'}`);
  if (evaluated > MAX_EVALUATED_PER_TOKEN) throw new Error(`Se evaluaron ${evaluated} códigos con un solo token`);
  if (after.mfaFailedAttempts !== evaluated) throw new Error('El contador no coincide con los códigos evaluados');
  if (burst.some((r) => r.status !== 401 && r.status !== 429)) throw new Error('Respuesta inesperada en la ráfaga');

  // 3. Seguir intentando con el mismo token hasta agotarlo: nunca más de 5 evaluaciones.
  for (let i = 0; i < 10; i++) {
    const r = await jar()('/auth/login/mfa', { method: 'POST', body: { pendingToken: pending.pendingToken, code: bad } });
    if (r.status === 401 && /vuelve a iniciar sesión/.test(r.data?.message)) break;
    if (r.status === 429 && /Espera/.test(r.data?.message)) break; // ya en espera
  }
  const locked = await user();
  console.log(`3. Tras insistir con el mismo token: mfaFailedAttempts=${locked.mfaFailedAttempts}, espera=${locked.mfaLockedUntil ? 'sí' : 'no'}`);
  if (locked.mfaFailedAttempts > MAX_EVALUATED_PER_TOKEN) throw new Error('El token permitió más de 5 evaluaciones');

  // Si la ráfaga no llegó a 5 evaluaciones (muchos 429 por intento en curso), completar hasta la espera.
  let fresh = expectStatus(await jar()('/auth/login', { method: 'POST', body: { email, password } }), 200, 'login');
  for (let i = 0; i < 10 && !(await user()).mfaLockedUntil; i++) {
    await jar()('/auth/login/mfa', { method: 'POST', body: { pendingToken: fresh.pendingToken, code: bad } });
  }
  const lockedNow = await user();
  if (!lockedNow.mfaLockedUntil) throw new Error('mfaLockedUntil no quedó fijado');

  // 4. Con la cuenta en espera, incluso el código correcto con un token nuevo → 429.
  fresh = expectStatus(await jar()('/auth/login', { method: 'POST', body: { email, password } }), 200, 'login');
  const blocked = await jar()('/auth/login/mfa', {
    method: 'POST', body: { pendingToken: fresh.pendingToken, code: await generate({ secret: setup.secret }) },
  });
  console.log(`4. Siguiente petición con el código correcto durante la espera: ${blocked.status} ${blocked.data?.message}`);
  if (blocked.status !== 429) throw new Error('Durante la espera se esperaba 429');
} catch (error) {
  failed = true;
  console.error(`FALLO: ${error.message}`);
} finally {
  // 5. Dejar la cuenta como estaba: esperar a que pase la espera y desactivar con recovery code.
  try {
    if (recoveryCodes) {
      const state = await user();
      const waitMs = Math.max(0, (state.mfaLockedUntil?.getTime() ?? 0) - Date.now()) + 1_000;
      console.log(`5. Esperando ${Math.ceil(waitMs / 1000)} s a que termine la espera para limpiar…`);
      await new Promise((r) => setTimeout(r, waitMs));
      const staff = jar();
      const p = expectStatus(await staff('/auth/login', { method: 'POST', body: { email, password } }), 200, 'login limpieza');
      expectStatus(await staff('/auth/login/mfa', { method: 'POST', body: { pendingToken: p.pendingToken, code: recoveryCodes[0] } }), 200, 'login/mfa limpieza');
      expectStatus(await staff('/auth/mfa/disable', { method: 'POST', body: { password, code: recoveryCodes[1] } }), 201, 'mfa/disable');
      const final = await user();
      console.log(`   MFA desactivado; mfaFailedAttempts=${final.mfaFailedAttempts}, mfaLockedUntil=${final.mfaLockedUntil ?? 'null'}`);
    }
  } catch (error) {
    failed = true;
    console.error(`FALLO en la limpieza: ${error.message}. Vuelve a sembrar la BD.`);
  }
  await prisma.$disconnect();
}
if (failed) process.exitCode = 1;
else console.log('OK: el límite de intentos por cuenta aguanta peticiones simultáneas.');
