// Verificación mínima contra PostgreSQL real de la lista de espera pública
// (POST /api/v1/public/waitlist). Datos 100 % ficticios. SOLO para BD desechables.
//
// Comprueba: form-token, alta 202 guardada cifrada (sin nombre ni email en claro), alta repetida
// 202 sin tocar la fila, 3 altas simultáneas del mismo email → una sola fila, sin Origin → 403,
// text/plain → 415, envío demasiado rápido → 400 y sexto envío desde la misma IP → 429.
// Al terminar borra las filas que ha creado.
//
// Requisitos: API local con TRUST_PROXY=loopback (cada bloque usa una IP de cliente distinta vía
// X-Forwarded-For para no consumir el cupo de los demás), WAITLIST_ALLOWED_ORIGINS vacío o con
// WAITLIST_ORIGIN, y DATABASE_URL de la misma BD.
// Variables: ASEPSICO_API_URL, DATABASE_URL, WAITLIST_ORIGIN (por defecto https://asepsico.es).
// Nunca imprime los datos enviados ni el contenido de la BD.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const API = process.env.ASEPSICO_API_URL || 'http://127.0.0.1:4000/api/v1';
const ORIGIN = process.env.WAITLIST_ORIGIN || 'https://asepsico.es';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (!LOCAL_HOSTS.has(new URL(API).hostname)) throw new Error('Solo contra una API local sobre una BD desechable');
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL (la misma BD desechable que usa la API)');

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PrismaClient } = requireFromApi('@prisma/client');
const prisma = new PrismaClient();

const URL_WAITLIST = `${API}/public/waitlist`;
const run = randomBytes(4).toString('hex');
const NAME = `Persona Ficticia CI ${run}`;
const EMAIL = `ci.ficticia.${run}@example.com`;
const EMAIL_CONC = `ci.concurrente.${run}@example.com`;
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let previousIds = null; // filas que ya existían: nunca se borran

function assert(cond, message) {
  if (!cond) throw new Error(message);
  console.log(`OK  ${message}`);
}

async function formToken(ip) {
  const res = await fetch(`${URL_WAITLIST}/form-token`, { headers: { origin: ORIGIN, 'x-forwarded-for': ip } });
  if (res.status !== 200) throw new Error(`form-token devolvió ${res.status}`);
  const json = await res.json();
  return { token: json.formToken, minSeconds: json.minSeconds };
}

function payload(token, extra = {}) {
  return {
    name: NAME, email: EMAIL, situation: 'SELF_EMPLOYED', tools: 'Agenda ficticia de CI', professionalsCount: 1,
    source: 'NOT_SAID', privacyAccepted: true, privacyPolicyVersion: 'lista-espera-v5', phone: '+34 600 000 001',
    formToken: token, ...extra,
  };
}

async function post(body, { ip, origin = ORIGIN, type = 'application/json' }) {
  const headers = { 'content-type': type, 'x-forwarded-for': ip };
  if (origin) headers.origin = origin;
  const res = await fetch(URL_WAITLIST, { method: 'POST', headers, body: JSON.stringify(body) });
  await res.arrayBuffer();
  return res.status;
}

async function main() {
  previousIds = new Set((await prisma.waitlistEntry.findMany({ select: { id: true } })).map((r) => r.id));
  const before = previousIds.size;

  // Bloque A (una IP): alta, repetida y 3 simultáneas = 5 envíos; el sexto → 429.
  const ipA = nextIp();
  const tokens = [];
  for (let i = 0; i < 6; i++) tokens.push(await formToken(ipA));
  await sleep((tokens[0].minSeconds + 0.5) * 1000);

  assert((await post(payload(tokens[0].token), { ip: ipA })) === 202, 'alta nueva → 202');
  const fresh = (await prisma.waitlistEntry.findMany()).filter((r) => !previousIds.has(r.id));
  assert((await prisma.waitlistEntry.count()) === before + 1, 'la alta crea exactamente una fila');
  const serialized = JSON.stringify(fresh);
  assert(fresh.length === 1 && /^enc:v\d:/.test(fresh[0].name ?? '') && /^enc:v\d:/.test(fresh[0].email ?? '') && !serialized.includes(NAME) && !serialized.includes(EMAIL), 'nombre y email cifrados en la BD (nada en claro)');
  const snapshot = JSON.stringify(await prisma.waitlistEntry.findMany({ orderBy: { id: 'asc' } }));

  assert((await post(payload(tokens[1].token, { name: 'Otro Nombre Ficticio', situation: 'PRACTICE' }), { ip: ipA })) === 202, 'alta repetida → 202');
  assert(JSON.stringify(await prisma.waitlistEntry.findMany({ orderBy: { id: 'asc' } })) === snapshot, 'la alta repetida no cambia la fila');

  const statuses = await Promise.all([2, 3, 4].map((i) => post(payload(tokens[i].token, { email: EMAIL_CONC }), { ip: ipA })));
  assert(statuses.every((s) => s === 202), `3 altas simultáneas → 202 (${statuses.join(',')})`);
  assert((await prisma.waitlistEntry.count()) === before + 2, 'las altas simultáneas dejan una sola fila');

  const sixth = await post(payload(tokens[5].token, { email: `ci.sexta.${run}@example.com` }), { ip: ipA });
  assert(sixth === 429, `sexto envío desde la misma IP → 429 (${sixth})`);

  // Bloque B (otra IP): rechazos que no deben crear filas.
  const ipB = nextIp();
  const fast = await formToken(ipB);
  assert((await post(payload(fast.token, { email: `ci.rapida.${run}@example.com` }), { ip: ipB })) === 400, 'envío demasiado rápido → 400');
  assert((await post(payload(tokens[0].token), { ip: ipB, origin: null })) === 403, 'sin Origin → 403');
  assert((await post(payload(tokens[0].token), { ip: ipB, type: 'text/plain' })) === 415, 'text/plain → 415');
  assert((await prisma.waitlistEntry.count()) === before + 2, 'los envíos rechazados no crean filas');
}

main()
  .then(() => console.log('Lista de espera verificada contra PostgreSQL real.'))
  .catch((error) => {
    console.error(`verify-waitlist falló: ${error instanceof Error ? error.message : 'error desconocido'}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (previousIds) await prisma.waitlistEntry.deleteMany({ where: { id: { notIn: [...previousIds] } } });
    await prisma.$disconnect();
  });
