// Verificación contra API y PostgreSQL reales del registro por invitación. Datos 100 % ficticios.
//
// SOLO para BD desechables (CI o local): crea invitaciones directamente en la BD (como el CLI) y
// deja los datos (la BD es de usar y tirar).
//
// Comprueba:
//  1. Ráfaga de registros simultáneos con el MISMO token de registro → exactamente un 201, el resto
//     400 REGISTRATION_NOT_ALLOWED, y ningún usuario ni workspace huérfano (rollback completo).
//  2. Lo mismo con un token de invitación de miembro.
//  3. El THERAPIST que entra por invitación recibe 403 de MFA antes de tocar datos clínicos.
//
// Requisitos: API local con TRUST_PROXY=loopback (cada petición usa su propia IP vía
// X-Forwarded-For para no chocar con el límite de 5/min de /auth/register) y DATABASE_URL de la
// misma BD. Variables: ASEPSICO_API_URL, DATABASE_URL. Nunca imprime tokens ni contraseñas.
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const API = process.env.ASEPSICO_API_URL || 'http://127.0.0.1:4000/api/v1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (!LOCAL_HOSTS.has(new URL(API).hostname)) throw new Error('Solo contra una API local sobre una BD desechable');
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL (la misma BD desechable que usa la API)');

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PrismaClient } = requireFromApi('@prisma/client');
const prisma = new PrismaClient();

const BURST = 10;
const stamp = Date.now();
const password = 'Aa1' + randomBytes(15).toString('base64url');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
let checks = 0;
let failures = 0;
function check(ok, label) { checks++; if (!ok) failures++; console.log(`   ${ok ? 'ok ' : 'FALLO'} ${label}`); }

let ipSeq = 0;
function client() {
  const ip = `198.51.100.${++ipSeq}`;
  const jar = new Map();
  return async (path, { method = 'GET', body } = {}) => {
    const headers = { 'x-forwarded-for': ip };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (!['GET', 'HEAD'].includes(method) && jar.get('csrf_token')) headers['x-csrf-token'] = decodeURIComponent(jar.get('csrf_token'));
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const raw of res.headers.getSetCookie?.() || []) { const [pair] = raw.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
}

async function main() {
  const termsRes = await fetch(`${API}/legal/terms`);
  if (!termsRes.ok) throw new Error(`GET /legal/terms → ${termsRes.status}`);
  const acceptedTerms = (await termsRes.json()).map(({ documentType, version, textHash }) => ({ documentType, version, textHash }));

  console.log(`1. ${BURST} registros simultáneos con el mismo token de registro`);
  const email = `qa-registro-${stamp}@example.test`;
  const workspaceName = `Consulta QA concurrencia ${stamp}`;
  const token = randomBytes(32).toString('base64url');
  const invite = await prisma.registrationInvite.create({ data: { email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 86_400_000), createdBy: 'verify-registration-invite-live' } });
  const clients = Array.from({ length: BURST }, () => client());
  const results = await Promise.all(clients.map((call) => call('/auth/register', {
    method: 'POST', body: { firstName: 'Titular', lastName: 'Ficticio', email, password, workspaceName, inviteToken: token, acceptedTerms },
  })));
  const created = results.filter((r) => r.status === 201);
  const neutral = results.filter((r) => r.status === 400 && r.data?.code === 'REGISTRATION_NOT_ALLOWED');
  check(created.length === 1, `exactamente un 201 (llegaron ${created.length}; estados ${results.map((r) => r.status).join(',')})`);
  check(neutral.length === BURST - 1, `el resto 400 REGISTRATION_NOT_ALLOWED (${neutral.length})`);
  const users = await prisma.user.findMany({ where: { email }, select: { id: true } });
  const workspaces = await prisma.workspace.findMany({ where: { name: workspaceName }, select: { id: true, members: { select: { userId: true, role: true } } } });
  check(users.length === 1, `un solo usuario con ese correo (${users.length})`);
  check(workspaces.length === 1, `un solo workspace creado, sin huérfanos (${workspaces.length})`);
  check(workspaces.every((w) => w.members.length === 1 && w.members[0].role === 'OWNER' && w.members[0].userId === users[0]?.id), 'el workspace tiene exactamente su OWNER');
  const used = await prisma.registrationInvite.findUnique({ where: { id: invite.id } });
  check(used.usedAt && used.usedByUserId === users[0]?.id && used.workspaceId === workspaces[0]?.id, 'la invitación apunta al usuario y workspace creados');
  check((await prisma.termsAcceptance.count({ where: { workspaceId: workspaces[0]?.id } })) === acceptedTerms.length, 'aceptaciones solo del registro ganador');
  const workspaceId = workspaces[0].id;
  const ownerId = users[0].id;

  console.log(`2. ${BURST} altas simultáneas con el mismo token de miembro (THERAPIST)`);
  const memberEmail = `qa-terapeuta-${stamp}@example.test`;
  const memberToken = randomBytes(32).toString('base64url');
  const memberInvite = await prisma.workspaceInvite.create({ data: {
    workspaceId, email: memberEmail, role: 'THERAPIST', isClinician: true, invitedById: ownerId,
    tokenHash: sha256(memberToken), expiresAt: new Date(Date.now() + 86_400_000),
  } });
  const memberClients = Array.from({ length: BURST }, () => client());
  const memberResults = await Promise.all(memberClients.map((call) => call('/auth/register/member', {
    method: 'POST', body: { firstName: 'Terapeuta', lastName: 'Ficticia', email: memberEmail, password, inviteToken: memberToken },
  })));
  const joinedIdx = memberResults.findIndex((r) => r.status === 201);
  check(memberResults.filter((r) => r.status === 201).length === 1, `exactamente un 201 (estados ${memberResults.map((r) => r.status).join(',')})`);
  check(memberResults.filter((r) => r.status === 400 && r.data?.code === 'REGISTRATION_NOT_ALLOWED').length === BURST - 1, 'el resto 400 neutro');
  check((await prisma.user.count({ where: { email: memberEmail } })) === 1, 'un solo usuario miembro, sin huérfanos');
  const member = await prisma.workspaceMember.findFirst({ where: { workspaceId, user: { email: memberEmail } } });
  check(member?.role === 'THERAPIST' && member.isClinician === true, 'membresía THERAPIST clínica');
  check((await prisma.workspaceInvite.findUnique({ where: { id: memberInvite.id } })).acceptedUserId === member?.userId, 'la invitación apunta al miembro creado');
  check(memberResults[joinedIdx]?.data?.privacyNotice?.documentType === 'PRIVACY_PRODUCT', 'la respuesta informa de la política de privacidad vigente');

  console.log('3. El THERAPIST invitado no toca nada clínico sin MFA');
  const therapist = memberClients[joinedIdx];
  for (const path of ['/patients', '/clinical-processes', '/sessions', `/patients/x/history`]) {
    const res = await therapist(path);
    check(res.status === 403 && /verificación en dos pasos/.test(res.data?.message ?? ''), `GET ${path} → 403 MFA (llegó ${res.status})`);
  }
  const setup = await therapist('/auth/mfa/setup', { method: 'POST' });
  check(setup.status === 201, `sí puede configurar el MFA (llegó ${setup.status})`);

  console.log(`\nResultado: ${checks - failures}/${checks} comprobaciones, ${failures} fallos`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
