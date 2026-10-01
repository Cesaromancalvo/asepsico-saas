// Verificación de extremo a extremo de la importación de pacientes (feat/importacion-pacientes)
// contra una API y un PostgreSQL REALES. Datos 100 % ficticios.
//
// SOLO para una BD desechable recién migrada y sembrada (npm run db:seed): crea usuarios de
// prueba en el workspace demo, activa su MFA e instala temporalmente un trigger en "Patient" para
// forzar el fallo de un bloque (lote PARTIAL). Por eso se niega a ejecutarse contra una API o una
// BD que no sean locales.
//
// Variables de entorno:
//   ASEPSICO_API_URL   URL base de la API (por defecto http://127.0.0.1:4000/api/v1).
//   DATABASE_URL       La MISMA BD que usa la API.
//   ASEPSICO_API_LOG   (opcional) fichero con la salida de la API: se comprueba que no contiene
//                      ningún nombre ni email ficticio de los importados.
//   La API debe arrancar con TRUST_PROXY=loopback (como en CI): cada petición lleva una IP de
//   cliente distinta en X-Forwarded-For para no chocar con los límites por IP de las rutas.
//
// Cubre: subida, vista previa, confirmación y deshacer con dos THERAPIST (B no ve los lotes ni los
// duplicados de A); 403 auditado para ASSISTANT; PARTIAL (fallo de sistema) con reintento sin
// duplicados; fallo de datos real aislado fila a fila (ROW_REJECTED); surrogate suelto y UTF-16; dos
// confirmaciones y dos deshacer simultáneos (409); deshacer con una cita posterior; minimización
// del fichero temporal tras la vista previa (descifrándolo); informe de errores sin fórmulas; y
// ausencia de datos de los pacientes en los logs de la API y en AuditLog.metadata.
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const API = process.env.ASEPSICO_API_URL || 'http://127.0.0.1:4000/api/v1';
const API_LOG = process.env.ASEPSICO_API_LOG || '';
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { PrismaClient } = requireFromApi('@prisma/client');
const bcrypt = requireFromApi('bcryptjs');
const { generate: totp } = requireFromApi('otplib');
const { strToU8, zipSync } = requireFromApi('fflate');

function assert(value, message) {
  if (!value) throw new Error(message);
}
let checks = 0;
const ok = (message) => {
  checks += 1;
  console.log(`   OK  ${message}`);
};

// ---------- Datos ficticios ----------
// Un sello solo con letras (los nombres no admiten dígitos) para localizar en logs y auditoría
// cualquier aparición de los datos importados.
const STAMP = [...randomBytes(6)].map((b) => String.fromCharCode(97 + (b % 26))).join('');
const TAG = `Qaimp${STAMP}`;
const emailOf = (i, set) => `qa-imp-${STAMP}-${set}-${i}@example.test`;
const firstNames = ['Zoraida', 'Leandro', 'Casilda', 'Fermin', 'Olvido', 'Teodoro', 'Brigida', 'Anselmo'];
const fakeRow = (i, set, firstName = firstNames[i % firstNames.length]) => [
  firstName,
  `${TAG} ${set} ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}`,
  emailOf(i, set),
  // Teléfono distinto por conjunto: un teléfono repetido cuenta como posible duplicado.
  `6${String(set.charCodeAt(0)).padStart(3, '0')}${String(i).padStart(5, '0')}`,
];
const csv = (header, rows) => [header, ...rows].map((r) => r.join(';')).join('\r\n') + '\r\n';
const HEADER = ['nombre', 'apellidos', 'email', 'telefono'];

// ---------- HTTP ----------
const randomIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

class Client {
  constructor(name) {
    this.name = name;
    this.jar = new Map();
  }
  capture(res) {
    for (const raw of res.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
  headers(method) {
    const h = { 'x-forwarded-for': randomIp() };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (!['GET', 'HEAD'].includes(method) && this.jar.get('csrf_token')) h['x-csrf-token'] = decodeURIComponent(this.jar.get('csrf_token'));
    return h;
  }
  async raw(path, { method = 'GET', body, form } = {}) {
    const headers = this.headers(method);
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(API + path, { method, headers, body: payload });
    this.capture(res);
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* CSV u otro texto */
    }
    return { status: res.status, data, text };
  }
  async req(path, options = {}) {
    const r = await this.raw(path, options);
    if (r.status < 200 || r.status >= 300) throw new Error(`[${this.name}] ${options.method || 'GET'} ${path}: ${r.status} ${r.text.slice(0, 300)}`);
    return r.data;
  }
  upload(content, fileName = 'pacientes.csv') {
    const form = new FormData();
    form.append('file', new Blob([content]), fileName);
    return this.raw('/patient-imports', { method: 'POST', form });
  }
}

// ---------- Preparación ----------
function assertLocalTargets() {
  assert(LOCAL.has(new URL(API).hostname), `Este script solo se ejecuta contra una API local (${new URL(API).hostname})`);
  const db = process.env.DATABASE_URL || '';
  assert(db, 'Falta DATABASE_URL (la misma BD que usa la API)');
  assert(LOCAL.has(new URL(db.replace(/^postgres(ql)?:/, 'http:')).hostname), 'Este script solo se ejecuta contra una BD local desechable');
}

const prisma = new PrismaClient();
const password = `Qa1${randomBytes(18).toString('base64url')}`;

async function createUser(workspaceId, key, role) {
  const email = `qa-import-${key}-${STAMP}@example.test`;
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(password, 10), firstName: 'Usuaria', lastName: `Prueba ${key}` },
  });
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
  return { ...user, email };
}

async function login(client, user, { mfa }) {
  const result = await client.req('/auth/login', { method: 'POST', body: { email: user.email, password } });
  assert(!result.mfaRequired, 'El usuario recién creado no debería tener MFA');
  if (!mfa) return;
  const setup = await client.req('/auth/mfa/setup', { method: 'POST' });
  await client.req('/auth/mfa/confirm', { method: 'POST', body: { password, code: await totp({ secret: setup.secret }) } });
  await client.req('/auth/refresh', { method: 'POST' });
}

/** Sube, mapea con la propuesta del servidor y devuelve { id, preview }. */
async function uploadAndPreview(client, content, fileName) {
  const up = await client.upload(content, fileName);
  assert(up.status === 201 || up.status === 200, `[${client.name}] subida: ${up.status} ${up.text.slice(0, 200)}`);
  const columns = up.data.columns.map((c) => ({ index: c.index, field: c.suggestedField }));
  const preview = await client.req(`/patient-imports/${up.data.id}/preview`, { method: 'POST', body: { hasHeaderRow: true, columns } });
  return { id: up.data.id, upload: up.data, preview };
}

const auditCount = (where) => prisma.auditLog.count({ where });

// ---------- Escenarios ----------
async function main() {
  assertLocalTargets();
  const { tsImport } = await import(pathToFileURL(requireFromApi.resolve('tsx/esm/api')).href);
  const crypto = await tsImport('../apps/api/src/common/crypto/field-encryption.ts', import.meta.url);

  const demo = await prisma.user.findUnique({ where: { email: 'demo@asepsico.es' }, include: { memberships: true } });
  assert(demo?.memberships[0], 'No existe la cuenta demo del seed: ejecuta npm run db:seed');
  const workspaceId = demo.memberships[0].workspaceId;
  const userA = await createUser(workspaceId, 'a', 'THERAPIST');
  const userB = await createUser(workspaceId, 'b', 'THERAPIST');
  const userC = await createUser(workspaceId, 'asis', 'ASSISTANT');
  const A = new Client('A');
  const B = new Client('B');
  const C = new Client('ASSISTANT');
  await login(A, userA, { mfa: true });
  await login(B, userB, { mfa: true });
  await login(C, userC, { mfa: false });

  console.log('1. Subida, vista previa (minimización) y confirmación de A');
  const rowsA = Array.from({ length: 5 }, (_, i) => fakeRow(i, 'a'));
  const secretMarker = `Marcador${STAMP}NoMapeado`;
  const clinicalMarker = `Clinico${STAMP}Vaciado`;
  const contentA = csv(
    [...HEADER, 'Notas', 'Referencia'],
    rowsA.map((r) => [...r, clinicalMarker, secretMarker]),
  );
  const upA = await A.upload(contentA);
  assert(upA.status === 201, `subida A: ${upA.status}`);
  const idA = upA.data.id;
  const notas = upA.data.columns.find((c) => c.index === 4);
  assert(notas?.clinical === true, 'La columna "Notas" no se marcó como clínica');
  let stored = crypto.decryptFieldStrict((await prisma.patientImportJob.findUnique({ where: { id: idA } })).payload);
  assert(!stored.includes(clinicalMarker), 'El contenido de la columna clínica llegó a guardarse');
  assert(stored.includes(secretMarker), 'Antes de la vista previa la columna no clínica debería seguir (cifrada)');
  ok('al subir, la columna clínica "Notas" se vacía antes de guardar; el fichero se guarda cifrado');

  const mapping = [0, 1, 2, 3].map((index) => ({ index, field: HEADER[index] })).concat([{ index: 5, field: 'NO_IMPORTAR' }]);
  const previewA = await A.req(`/patient-imports/${idA}/preview`, { method: 'POST', body: { hasHeaderRow: true, columns: mapping } });
  assert(previewA.summary.valid === 5, `vista previa A: ${JSON.stringify(previewA.summary)}`);
  const jobRow = await prisma.patientImportJob.findUnique({ where: { id: idA } });
  assert(/^enc:v[12]:/.test(jobRow.payload), 'El fichero temporal no está cifrado en la BD');
  const payload = JSON.parse(crypto.decryptFieldStrict(jobRow.payload));
  for (const row of payload.rows) {
    row.cells.forEach((cell, index) => assert(index <= 3 || cell === '', `Tras la vista previa la columna ${index} conserva datos`));
  }
  assert(!JSON.stringify(payload).includes(secretMarker), 'La columna no asignada sigue en el fichero temporal');
  assert(JSON.stringify(payload.discardedColumns) === '[4,5]', `discardedColumns inesperado: ${JSON.stringify(payload.discardedColumns)}`);
  ok('tras la vista previa el payload descifrado solo contiene las columnas mapeadas (0-3); 4 y 5 descartadas');

  const confirmedA = await A.req(`/patient-imports/${idA}/confirm`, { method: 'POST', body: {} });
  assert(confirmedA.status === 'COMPLETED' && confirmedA.createdCount === 5, `confirmación A: ${JSON.stringify(confirmedA)}`);
  assert((await prisma.patientImportJob.findUnique({ where: { id: idA } })).payload === null, 'El fichero temporal no se borró al completar');
  const itemsA = await prisma.patientImportItem.findMany({ where: { jobId: idA }, orderBy: { rowNumber: 'asc' } });
  assert(itemsA.length === 5, 'No hay 5 pacientes vinculados al lote de A');
  const procs = await prisma.clinicalProcess.findMany({ where: { id: { in: itemsA.map((i) => i.clinicalProcessId) } } });
  assert(procs.every((p) => p.therapistId === userA.id && p.consultationReason === null), 'Los procesos importados no son de A o tienen contenido');
  ok('confirmación: 5 pacientes con proceso mínimo a nombre de A, fichero temporal borrado');

  console.log('2. Aislamiento entre THERAPIST: B no ve nada de A');
  for (const [method, path, body] of [
    ['GET', `/patient-imports/${idA}`],
    ['GET', `/patient-imports/${idA}/error-report`],
    ['POST', `/patient-imports/${idA}/preview`, { hasHeaderRow: true, columns: mapping.slice(0, 2) }],
    ['POST', `/patient-imports/${idA}/confirm`, {}],
    ['POST', `/patient-imports/${idA}/cancel`],
    ['POST', `/patient-imports/${idA}/revert`],
  ]) {
    const r = await B.raw(path, { method, body });
    assert(r.status === 404, `B ${method} ${path} → ${r.status} (se esperaba 404)`);
    assert(!r.text.includes(TAG), `La respuesta 404 a B filtra datos de A (${path})`);
  }
  const listB = await B.req('/patient-imports');
  assert(!listB.some((j) => j.id === idA), 'B ve el lote de A en su listado');
  ok('B recibe 404 en ver, informe, vista previa, confirmar, cancelar y deshacer el lote de A, y no lo lista');

  const sameAsA = csv(HEADER, rowsA.map((r) => [r[0], r[1], r[2], r[3]]));
  const dupB = await uploadAndPreview(B, sameAsA);
  assert(dupB.preview.summary.duplicates === 0 && dupB.preview.rows.every((r) => !r.duplicate), `B ve duplicados de A: ${JSON.stringify(dupB.preview.summary)}`);
  assert(!JSON.stringify(dupB.preview).includes(itemsA[0].patientId), 'La vista previa de B contiene ids de pacientes de A');
  ok('la vista previa de B con los mismos nombres y emails que A no encuentra coincidencias (0 duplicados)');
  await B.req(`/patient-imports/${dupB.id}/cancel`, { method: 'POST' });

  const patientsB = await B.req(`/patients?q=${encodeURIComponent(TAG)}&pageSize=100`);
  assert(!patientsB.data.some((p) => itemsA.some((i) => i.patientId === p.id)), 'GET /patients de B incluye pacientes importados por A');
  const patientsA = await A.req(`/patients?q=${encodeURIComponent(TAG)}&pageSize=100`);
  assert(itemsA.every((i) => patientsA.data.some((p) => p.id === i.patientId)), 'GET /patients de A no incluye sus importados');
  ok('GET /patients de B no incluye a los importados por A (A sí los ve)');

  const dupA = await uploadAndPreview(A, sameAsA);
  assert(dupA.preview.summary.duplicates === 5, `A debería ver 5 duplicados de sus propios pacientes: ${JSON.stringify(dupA.preview.summary)}`);
  await A.req(`/patient-imports/${dupA.id}/cancel`, { method: 'POST' });
  ok('control: A sí ve como duplicados a sus propios pacientes');

  console.log('3. ASSISTANT: 403 auditado');
  const forbiddenBefore = await auditCount({ workspaceId, actorId: userC.id, action: 'PATIENT_IMPORT_FORBIDDEN' });
  const denied = [
    await C.upload(csv(HEADER, [fakeRow(0, 'c')])),
    await C.raw('/patient-imports'),
    await C.raw('/patient-imports/template?format=csv'),
    await C.raw(`/patient-imports/${idA}`),
    await C.raw(`/patient-imports/${idA}/revert`, { method: 'POST' }),
  ];
  assert(denied.every((r) => r.status === 403), `ASSISTANT: ${denied.map((r) => r.status).join(',')}`);
  const forbiddenAudits = await prisma.auditLog.findMany({ where: { workspaceId, actorId: userC.id, action: 'PATIENT_IMPORT_FORBIDDEN' } });
  assert(forbiddenAudits.length - forbiddenBefore === 5, `Se esperaban 5 auditorías PATIENT_IMPORT_FORBIDDEN y hay ${forbiddenAudits.length}`);
  assert(forbiddenAudits.every((a) => a.metadata?.role === 'ASSISTANT' && Object.keys(a.metadata).sort().join() === 'operation,role'), 'La auditoría del 403 lleva algo más que rol y operación');
  assert((await prisma.patientImportJob.count({ where: { importerId: userC.id } })) === 0, 'El ASSISTANT llegó a crear un lote');
  ok('ASSISTANT recibe 403 en subir, listar, plantilla, ver y deshacer; 5 auditorías con solo rol y operación');

  // Trigger temporal que hace fallar el INSERT de la fila "Bloqueo" con un error REAL de
  // PostgreSQL/Prisma. errcode '40001' (serialization_failure → P2034) es un fallo de sistema;
  // sin errcode, RAISE da un PrismaClientUnknownRequestError, que se trata como fallo de datos.
  async function withFailingInsert(set, errcode, fn) {
    const using = errcode ? ` USING ERRCODE = '${errcode}'` : '';
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION qa_import_fail() RETURNS trigger AS $$ BEGIN
      IF NEW."firstName" = 'Bloqueo' AND NEW."lastName" LIKE '${TAG} ${set} %' THEN RAISE EXCEPTION 'fallo forzado por QA'${using}; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER qa_import_fail BEFORE INSERT ON "Patient" FOR EACH ROW EXECUTE FUNCTION qa_import_fail()');
    try {
      return await fn();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS qa_import_fail ON "Patient"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS qa_import_fail()');
    }
  }

  console.log('4. PARTIAL por fallo de sistema, con reintento sin duplicados');
  const rowsP = Array.from({ length: 150 }, (_, i) => fakeRow(i, 'p', i === 120 ? 'Bloqueo' : undefined));
  const partial = await uploadAndPreview(A, csv(HEADER, rowsP));
  assert(partial.preview.summary.valid === 150, `vista previa PARTIAL: ${JSON.stringify(partial.preview.summary)}`);
  const first = await withFailingInsert('p', '40001', () => A.req(`/patient-imports/${partial.id}/confirm`, { method: 'POST', body: {} }));
  assert(first.status === 'PARTIAL' && first.createdCount === 100 && first.processedRows === 100 && first.canRetry === true, `primer intento: ${JSON.stringify(first)}`);
  assert((await prisma.patientImportItem.count({ where: { jobId: partial.id } })) === 100, 'El bloque fallido dejó rastro');
  ok('un fallo de sistema (P2034) en el 2.º bloque deja el lote en PARTIAL con 100 creados y el bloque sin rastro');
  const retry = await A.req(`/patient-imports/${partial.id}/confirm`, { method: 'POST', body: {} });
  assert(retry.status === 'COMPLETED' && retry.createdCount === 150, `reintento: ${JSON.stringify(retry)}`);
  const partialPatients = await prisma.patient.findMany({ where: { workspaceId, lastName: { startsWith: `${TAG} p ` } }, select: { email: true } });
  assert(partialPatients.length === 150 && new Set(partialPatients.map((p) => p.email)).size === 150, `tras el reintento hay ${partialPatients.length} pacientes`);
  ok('el reintento reanuda en el cursor: 150 pacientes exactos, ninguno duplicado');

  console.log('4b. Fallo de DATOS real de Prisma: se aísla fila a fila');
  const rowsR = Array.from({ length: 150 }, (_, i) => fakeRow(i, 'r', i === 120 ? 'Bloqueo' : undefined));
  const rejected = await uploadAndPreview(A, csv(HEADER, rowsR));
  const rejectedRow = rejected.preview.rows.find((r) => r.values?.firstName === 'Bloqueo').rowNumber;
  const isolated = await withFailingInsert('r', null, () => A.req(`/patient-imports/${rejected.id}/confirm`, { method: 'POST', body: {} }));
  assert(isolated.status === 'COMPLETED' && isolated.createdCount === 149 && isolated.errorCount === 1, `aislamiento: ${JSON.stringify(isolated)}`);
  const rejectedJob = await prisma.patientImportJob.findUnique({ where: { id: rejected.id } });
  assert(rejectedJob.errorReport.some((e) => e.row === rejectedRow && e.code === 'ROW_REJECTED'), `errorReport sin ROW_REJECTED: ${JSON.stringify(rejectedJob.errorReport)}`);
  assert((await prisma.patient.count({ where: { workspaceId, lastName: { startsWith: `${TAG} r ` } } })) === 149, 'No hay 149 pacientes del lote');
  const rejectedReport = await A.raw(`/patient-imports/${rejected.id}/error-report`);
  assert(rejectedReport.text.includes(`${rejectedRow};fila;`) && !rejectedReport.text.includes('Bloqueo'), 'El informe no marca la fila rechazada o repite su valor');
  ok(`el error real (PrismaClientUnknownRequestError) rechaza solo la fila ${rejectedRow}: COMPLETED con 149 creados y ROW_REJECTED en el informe`);

  console.log('4c. Surrogate suelto (&#xD800;) en un XLSX y parte UTF-16');
  const xlsxBook = (sheetXml) =>
    Buffer.from(
      zipSync({
        'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="H" sheetId="1" r:id="rId1"/></sheets></workbook>'),
        'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
        'xl/worksheets/sheet1.xml': sheetXml,
      }),
    );
  const xc = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
  const sRows = [['nombre', 'apellidos'], ...Array.from({ length: 3 }, (_, i) => [i === 1 ? 'Ana&#xD800;' : 'Zoraida', `${TAG} s ${'abc'[i]}`])];
  const sXml = `<worksheet><sheetData>${sRows.map((r, i) => `<row r="${i + 1}">${xc(`A${i + 1}`, r[0])}${xc(`B${i + 1}`, r[1])}</row>`).join('')}</sheetData></worksheet>`;
  const surrogate = await uploadAndPreview(A, xlsxBook(strToU8(sXml)), 'pacientes.xlsx');
  const sConfirm = await A.req(`/patient-imports/${surrogate.id}/confirm`, { method: 'POST', body: {} });
  assert(sConfirm.status === 'COMPLETED', `el lote con &#xD800; terminó en ${sConfirm.status}: ${JSON.stringify(sConfirm)}`);
  const sStored = await prisma.patient.findMany({ where: { workspaceId, lastName: { startsWith: `${TAG} s ` } }, select: { firstName: true } });
  assert(sStored.every((p) => !/[\uD800-\uDFFF]/.test(p.firstName)), 'Se guardó un surrogate suelto');
  const sRow = surrogate.preview.rows.find((r) => r.rowNumber === 3);
  const sMarked = sRow.status === 'ERROR' && sRow.errors.some((e) => e.code === 'INVALID_TEXT');
  assert(sMarked || sStored.length === 3, `la fila del surrogate ni se marca INVALID_TEXT ni se importa limpia: ${JSON.stringify(sRow.errors)}`);
  ok(`&#xD800;: lote COMPLETED (no PARTIAL), ${sStored.length} creados; la fila ${sMarked ? 'queda como INVALID_TEXT' : 'se importa sin el surrogate'}`);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sXml.replace('Ana&#xD800;', 'Ana'), 'utf16le')]);
  const u16 = await A.upload(xlsxBook(new Uint8Array(utf16)), 'pacientes.xlsx');
  assert(u16.status === 400 && u16.text.includes('UNSUPPORTED_ENCODING'), `XLSX en UTF-16: ${u16.status} ${u16.text.slice(0, 200)}`);
  const u16csv = await A.upload(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('nombre;apellidos\r\nZoraida;Ficticia\r\n', 'utf16le')]));
  assert(u16csv.status === 400 && u16csv.text.includes('UNSUPPORTED_ENCODING'), `CSV en UTF-16: ${u16csv.status} ${u16csv.text.slice(0, 200)}`);
  ok('XLSX y CSV en UTF-16 se rechazan con UNSUPPORTED_ENCODING (400)');

  console.log('5. Dos confirmaciones simultáneas');
  const conc = await uploadAndPreview(A, csv(HEADER, Array.from({ length: 150 }, (_, i) => fakeRow(i, 'k'))));
  const both = await Promise.all([1, 2].map(() => A.raw(`/patient-imports/${conc.id}/confirm`, { method: 'POST', body: {} })));
  const statuses = both.map((r) => r.status).sort();
  assert(statuses.join() === '200,409', `confirmaciones simultáneas: ${statuses.join(',')}`);
  const concJob = await A.req(`/patient-imports/${conc.id}`);
  const concPatients = await prisma.patient.count({ where: { workspaceId, lastName: { startsWith: `${TAG} k ` } } });
  assert(concJob.status === 'COMPLETED' && concJob.createdCount === 150 && concPatients === 150, `tras la carrera: ${concJob.status}, ${concJob.createdCount}, ${concPatients}`);
  assert((await auditCount({ entityId: conc.id, action: 'PATIENT_IMPORT_BATCH' })) === 1, 'Hay más de una auditoría de lote');
  ok('una gana (200) y la otra recibe 409; 150 pacientes y una sola auditoría de lote');

  console.log('6. Dos deshacer simultáneos');
  const revBoth = await Promise.all([1, 2].map(() => A.raw(`/patient-imports/${conc.id}/revert`, { method: 'POST' })));
  const revStatuses = revBoth.map((r) => r.status).sort();
  assert(revStatuses.join() === '200,409', `deshacer simultáneos: ${revStatuses.join(',')}`);
  const revJob = await A.req(`/patient-imports/${conc.id}`);
  const left = await prisma.patient.count({ where: { workspaceId, lastName: { startsWith: `${TAG} k ` } } });
  const leftItems = await prisma.patientImportItem.count({ where: { jobId: conc.id } });
  assert(revJob.status === 'REVERTED' && revJob.revertedCount === 150 && left === 0 && leftItems === 0 && revJob.canRevert === false, `tras deshacer: ${JSON.stringify(revJob)}, quedan ${left}`);
  assert((await auditCount({ entityId: conc.id, action: 'PATIENT_IMPORT_BATCH_REVERTED' })) === 1, 'Hay más de una auditoría de deshacer');
  const again = await A.raw(`/patient-imports/${conc.id}/revert`, { method: 'POST' });
  assert(again.status === 409, `deshacer un lote REVERTED: ${again.status}`);
  ok('uno gana y el otro 409; estado REVERTED, 150 deshechos, 0 pacientes ni vínculos, una auditoría');

  console.log('7. Deshacer con actividad posterior (una cita)');
  const target = itemsA[0];
  const startsAt = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  await A.req('/sessions', {
    method: 'POST',
    body: { patientId: target.patientId, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 50 * 60 * 1000).toISOString() },
  });
  const reverted = await A.req(`/patient-imports/${idA}/revert`, { method: 'POST' });
  assert(JSON.stringify(reverted.notRevertedRows) === JSON.stringify([target.rowNumber]), `filas no deshechas: ${JSON.stringify(reverted.notRevertedRows)}`);
  assert(reverted.revertedCount === 4 && reverted.status === 'COMPLETED', `lote tras deshacer: ${JSON.stringify(reverted)}`);
  assert(await prisma.patient.findUnique({ where: { id: target.patientId } }), 'Se borró el paciente que tenía una cita');
  assert((await prisma.patient.count({ where: { id: { in: itemsA.slice(1).map((i) => i.patientId) } } })) === 0, 'Quedan pacientes sin actividad sin deshacer');
  ok('el paciente con cita se conserva (fila informada) y los otros 4 se deshacen');

  console.log('8. Informe de errores con =HYPERLINK(...)');
  const hyperlink = '=HYPERLINK("http://example.test/qa","Pulsa")';
  const bad = await uploadAndPreview(A, csv(HEADER, [[hyperlink, `${TAG} h`, hyperlink, '+=1+1'], fakeRow(1, 'h')]));
  assert(bad.preview.summary.errors === 1, `vista previa con fórmula: ${JSON.stringify(bad.preview.summary)}`);
  // La vista previa enseña al importador sus propios valores; lo que no debe repetirlos son los
  // errores (que acaban en el informe descargable).
  const badRow = bad.preview.rows.find((r) => r.status === 'ERROR');
  assert(badRow && !JSON.stringify(badRow.errors).includes('HYPERLINK'), 'Los errores de la vista previa repiten la fórmula');
  const report = await A.raw(`/patient-imports/${bad.id}/error-report`);
  assert(report.status === 200, `informe: ${report.status}`);
  assert(!/HYPERLINK|example\.test/i.test(report.text), 'El informe de errores contiene la fórmula o la URL');
  const cells = report.text.replace(/^﻿/, '').split(/\r\n/).filter(Boolean).flatMap((l) => l.split(';'));
  assert(cells.every((c) => !/^[=+\-@\t\r]/.test(c)), 'Alguna celda del informe empieza por un carácter de fórmula');
  assert(!JSON.stringify((await prisma.patientImportJob.findUnique({ where: { id: bad.id } })).errorReport).includes('HYPERLINK'), 'errorReport guarda la fórmula');
  ok('el informe solo lleva fila, columna y motivo: ni la fórmula ni la URL, y ninguna celda empieza por = + - @');
  await A.req(`/patient-imports/${bad.id}/cancel`, { method: 'POST' });

  console.log('9. Datos de los pacientes fuera de logs y auditoría');
  const needles = [TAG, `qa-imp-${STAMP}`, secretMarker, clinicalMarker];
  const auditHits = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "AuditLog" WHERE ${needles.map((_, i) => `metadata::text ILIKE $${i + 1}`).join(' OR ')}`,
    ...needles.map((n) => `%${n}%`),
  );
  assert(auditHits[0].n === 0, `AuditLog.metadata contiene datos ficticios de los pacientes (${auditHits[0].n})`);
  const importAudits = await auditCount({ workspaceId, action: { startsWith: 'PATIENT_IMPORT' } });
  ok(`AuditLog.metadata: 0 apariciones de nombres, emails y marcadores (${importAudits} auditorías de importación revisadas)`);
  if (API_LOG) {
    assert(existsSync(API_LOG), `No existe ${API_LOG}`);
    const log = readFileSync(API_LOG, 'utf8');
    const hits = needles.filter((n) => log.toLowerCase().includes(n.toLowerCase()));
    assert(hits.length === 0, `El log de la API contiene datos ficticios de pacientes (${hits.length} patrones)`);
    assert(/Importación .* falló el bloque/.test(log), 'El log no registra el fallo del bloque (el fallo forzado no llegó a la API)');
    ok(`log de la API: 0 apariciones (${log.split('\n').length} líneas, incluido el aviso del bloque fallido)`);
  } else {
    console.log('   AVISO: sin ASEPSICO_API_LOG no se revisa el log de la API (no se da por pasado)');
  }

  console.log(`OK: ${checks} comprobaciones de la importación de pacientes en verde.`);
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`FALLO: ${error.message}`);
} finally {
  await prisma.$disconnect();
}
if (failed) process.exitCode = 1;
