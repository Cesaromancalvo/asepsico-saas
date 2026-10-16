// Verificación contra API y PostgreSQL reales (condición de Argos, S3): recepción (ASSISTANT) anula
// un cobro y revierte un pago por HTTP, y la auditoría queda en el export del workspace sin el texto
// libre del motivo. Datos 100 % ficticios.
//
// SOLO para BD desechables: crea dos workspaces de prueba (el segundo, para el acceso indebido
// entre consultas) y deja los datos en la BD (la BD es de usar y tirar).
//
// Comprueba:
//  - ASSISTANT crea, confirma, cobra, revierte el pago y anula el cobro (200/201 en cada paso).
//  - Las respuestas a ASSISTANT no llevan el motivo: voidReason / reversalReason a null con
//    <campo>Hidden: true.
//  - ASSISTANT no puede exportar el workspace (403) y no deja WORKSPACE_DATA_EXPORTED.
//  - Un ASSISTANT de OTRA consulta no puede revertir ni anular (404) ni deja auditoría.
//  - El export del OWNER (POST /exports/workspace con contraseña) incluye INVOICE_CREATED,
//    INVOICE_ISSUED, PAYMENT_RECORDED, PAYMENT_REVERSED e INVOICE_VOIDED con el ASSISTANT como
//    actor; los metadatos de PAYMENT_REVERSED e INVOICE_VOIDED son exactamente
//    { invoiceId, reasonProvided: true } y ningún motivo aparece en todo el export.
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
// Motivos administrativos ficticios con una marca única para buscarlos en el export.
const VOID_REASON = `Cobro duplicado por error QAVOID${stamp}`;
const REVERSAL_REASON = `Pago registrado dos veces QAREV${stamp}`;

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
  const ip = `198.51.100.${200 + (++ipSeq)}`;
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

async function newWorkspace(label, defs, acceptedTerms, hash) {
  const workspace = await prisma.workspace.create({ data: { name: `Consulta QA cobros ${label} ${stamp}` } });
  const actors = {};
  for (const [key, def] of Object.entries(defs)) {
    const email = `qa-cobros-${label}-${key}-${stamp}@example.test`;
    const user = await prisma.user.create({ data: { email, passwordHash: hash, firstName: `QA ${key}`, lastName: 'Ficticio' } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: def.role, isClinician: false } });
    await prisma.termsAcceptance.createMany({ data: acceptedTerms.map((t) => ({ workspaceId: workspace.id, userId: user.id, ...t, userAgent: 'verify-billing-assistant-live' })) });
    actors[key] = client(`${label}-${key}`);
    await login(actors[key], email, def.mfa);
    must(actors[key].userId === user.id, `login de ${label}-${key} no devolvió su id`);
  }
  return { workspace, actors };
}

async function main() {
  console.log('1. Preparar dos consultas ficticias (OWNER con MFA y ASSISTANT sin MFA)');
  const hash = await bcrypt.hash(password, 10);
  const termsRes = await fetch(`${API}/legal/terms`);
  must(termsRes.ok, `GET /legal/terms → ${termsRes.status}`);
  const acceptedTerms = (await termsRes.json()).map(({ documentType, version, textHash }) => ({ documentType, version, textHash }));
  const { workspace, actors: A } = await newWorkspace('a', {
    owner: { role: 'OWNER', mfa: true },
    assistant: { role: 'ASSISTANT', mfa: false },
  }, acceptedTerms, hash);
  const { actors: B } = await newWorkspace('b', { assistant: { role: 'ASSISTANT', mfa: false } }, acceptedTerms, hash);

  const patient = await A.owner.ok('/patients', { method: 'POST', body: { firstName: 'Paciente', lastName: `Ficticio ${stamp}` } });
  must(patient?.id, 'el OWNER no pudo crear el paciente ficticio');

  console.log('2. ASSISTANT: crear, confirmar y cobrar');
  const invoice = await A.assistant.ok('/billing/invoices', {
    method: 'POST',
    body: { patientId: patient.id, lines: [{ description: 'Sesión individual', quantity: 1, unitPriceCents: 6000 }] },
  });
  must(invoice?.id, 'el ASSISTANT no pudo crear el cobro');
  const issued = await A.assistant.ok(`/billing/invoices/${invoice.id}/issue`, { method: 'POST' });
  check(issued.status === 'ISSUED', `cobro confirmado (${issued.status})`);
  const payment = await A.assistant.ok('/billing/payments', {
    method: 'POST', body: { invoiceId: invoice.id, amountCents: 6000, method: 'CARD' },
  });
  must(payment?.id, 'el ASSISTANT no pudo registrar el pago');

  console.log('3. Acceso indebido: ASSISTANT de otra consulta');
  const auditBefore = await prisma.auditLog.count({ where: { actorId: B.assistant.userId } });
  const crossReverse = await B.assistant.call(`/billing/payments/${payment.id}/reverse`, { method: 'POST', body: { reason: 'Intento ajeno' } });
  check(crossReverse.status === 404, `otra consulta revierte el pago → 404 (llegó ${crossReverse.status})`);
  const crossVoid = await B.assistant.call(`/billing/invoices/${invoice.id}/void`, { method: 'POST', body: { reason: 'Intento ajeno' } });
  check(crossVoid.status === 404, `otra consulta anula el cobro → 404 (llegó ${crossVoid.status})`);
  const paymentRow = await prisma.payment.findUnique({ where: { id: payment.id } });
  check(paymentRow.reversedAt === null, 'el pago sigue sin revertir tras el intento ajeno');
  check((await prisma.auditLog.count({ where: { actorId: B.assistant.userId } })) === auditBefore, 'el intento ajeno no deja auditoría de cambio');

  console.log('4. ASSISTANT: revertir el pago y anular el cobro');
  const reversed = await A.assistant.call(`/billing/payments/${payment.id}/reverse`, { method: 'POST', body: { reason: REVERSAL_REASON } });
  check(reversed.status === 201 || reversed.status === 200, `revertir pago → ${reversed.status}`);
  check(reversed.data?.reversedAt && reversed.data.reversalReason === null && reversed.data.reversalReasonHidden === true,
    'la respuesta al ASSISTANT no lleva el motivo de reversión (null + reversalReasonHidden)');
  check(!reversed.text.includes(`QAREV${stamp}`), 'el motivo de reversión no aparece en la respuesta');
  const voided = await A.assistant.call(`/billing/invoices/${invoice.id}/void`, { method: 'POST', body: { reason: VOID_REASON } });
  check(voided.status === 201 || voided.status === 200, `anular cobro → ${voided.status}`);
  check(voided.data?.status === 'VOID' && voided.data.voidReason === null && voided.data.voidReasonHidden === true,
    'la respuesta al ASSISTANT no lleva el motivo de anulación (null + voidReasonHidden)');
  check(!voided.text.includes(`QAVOID${stamp}`), 'el motivo de anulación no aparece en la respuesta');
  const stored = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  check(stored.status === 'VOID' && stored.workspaceId === workspace.id, 'en la BD el cobro queda VOID en su consulta');

  console.log('5. Export del workspace');
  const assistantExport = await A.assistant.call('/exports/workspace', { method: 'POST', body: { password } });
  check(assistantExport.status === 403, `ASSISTANT exporta el workspace → 403 (llegó ${assistantExport.status})`);
  check((await prisma.auditLog.count({ where: { actorId: A.assistant.userId, action: 'WORKSPACE_DATA_EXPORTED' } })) === 0,
    'el 403 no deja WORKSPACE_DATA_EXPORTED');
  const exportRes = await A.owner.call('/exports/workspace', { method: 'POST', body: { password } });
  must(exportRes.status === 201 || exportRes.status === 200, `OWNER exporta el workspace → ${exportRes.status} ${exportRes.text.slice(0, 200)}`);
  const logs = exportRes.data.recentAuditLogs ?? [];
  const byAssistant = (action, entityId) => logs.filter((row) => row.action === action && row.entityId === entityId && row.actorId === A.assistant.userId);
  for (const [action, entityId] of [
    ['INVOICE_CREATED', invoice.id], ['INVOICE_ISSUED', invoice.id], ['PAYMENT_RECORDED', payment.id],
    ['PAYMENT_REVERSED', payment.id], ['INVOICE_VOIDED', invoice.id],
  ]) {
    check(byAssistant(action, entityId).length === 1, `export: ${action} con el ASSISTANT como actor (${byAssistant(action, entityId).length})`);
  }
  for (const action of ['PAYMENT_REVERSED', 'INVOICE_VOIDED']) {
    const entityId = action === 'PAYMENT_REVERSED' ? payment.id : invoice.id;
    const [row] = byAssistant(action, entityId);
    const keys = Object.keys(row?.metadata ?? {}).sort().join(',');
    check(keys === 'invoiceId,reasonProvided' && row.metadata.invoiceId === invoice.id && row.metadata.reasonProvided === true,
      `export: ${action} con metadatos solo {invoiceId, reasonProvided: true} (${keys})`);
  }
  check(logs.every((row) => row.workspaceId === undefined || row.workspaceId === workspace.id), 'export: solo auditoría de su consulta');
  check(!logs.some((row) => row.actorId === B.assistant.userId), 'export: nada del ASSISTANT de la otra consulta');
  check(!exportRes.text.includes(`QAVOID${stamp}`) && !exportRes.text.includes(`QAREV${stamp}`),
    'export: ningún motivo de anulación ni de reversión en todo el documento');

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
