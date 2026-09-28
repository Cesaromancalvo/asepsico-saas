/**
 * Cifra en la base de datos los valores de campos marcados como cifrados que siguen en claro
 * (datos anteriores a activar el cifrado) y, con --rotate, reescribe con la clave activa los
 * que estén cifrados con otra (enc:v1 o enc:v2 con un kid antiguo).
 *
 * La lista de campos sale de src/common/crypto/clinical-crypto.ts (la misma que usa la API).
 * Además migra ClinicalAssessment.totalScore/severity/riskFlag (legado en claro) al campo
 * cifrado `result` y vacía esas columnas (paso previo a eliminarlas en una migración posterior).
 *
 *   npm run db:encrypt-fields -- --dry-run            # solo cuenta, no escribe nada
 *   npm run db:encrypt-fields                         # cifra lo que esté en claro
 *   npm run db:encrypt-fields -- --rotate             # además, re-cifra con la clave activa
 *   Opciones: --batch-size=200
 *
 * Entorno: DATABASE_URL y la configuración de claves de la API (FIELD_ENCRYPTION_KEY y/o
 * FIELD_ENCRYPTION_KEYS + FIELD_ENCRYPTION_ACTIVE_KID). Se niega a usar la clave de desarrollo
 * implícita salvo con --allow-dev-key (para no cifrar una BD real con una clave pública).
 *
 * Garantías:
 *  - Idempotente: un valor ya cifrado con la clave activa no se toca.
 *  - Nunca registra valores, solo recuentos por modelo/campo.
 *  - Lotes por cursor de id; cada lote se escribe en una transacción.
 *  - Compare-and-set: cada UPDATE exige que el valor siga siendo el leído; si la API lo cambió
 *    entretanto, no se sobrescribe (se cuenta como "conflictos" y basta con relanzar).
 *  - Conserva updatedAt (no altera el orden de "última modificación" de la aplicación).
 *  - Antes de escribir nada hace una pasada completa de verificación: intenta descifrar TODOS
 *    los valores ya cifrados. Si alguno no se puede descifrar con las claves configuradas
 *    (clave ausente o incorrecta), aborta sin escribir y termina con código 2: así nunca se
 *    mezclan en la BD valores cifrados con una clave equivocada.
 *  - Mantenimiento transversal a todos los workspaces: filtra por id (clave primaria), no por
 *    workspaceId, porque no actúa en nombre de ningún usuario ni de ningún workspace.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import {
  activeEncryptionKid,
  decryptFieldStrict,
  encryptField,
  encryptedValueKid,
  isEncryptedValue,
} from '../../src/common/crypto/field-encryption';
import { ASSESSMENT_RESULT_LEGACY_FIELDS, ENCRYPTED_JSON_FIELDS, ENCRYPTED_TEXT_FIELDS, encryptAssessmentResult } from '../../src/common/crypto/clinical-crypto';

type Counters = { scanned: number; plaintext: number; rotate: number; ok: number; unreadable: number; written: number; conflicts: number };
type FieldKind = 'text' | 'json';
type Change = { id: string; where: Record<string, unknown>; data: Record<string, unknown> };

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ROTATE = args.includes('--rotate');
const ALLOW_DEV_KEY = args.includes('--allow-dev-key');
const BATCH_SIZE = Number(args.find((a) => a.startsWith('--batch-size='))?.split('=')[1] ?? 200);

function assertConfig() {
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
  const hasKey = Boolean(process.env.FIELD_ENCRYPTION_KEY || process.env.FIELD_ENCRYPTION_KEYS);
  if (!hasKey && !ALLOW_DEV_KEY) {
    throw new Error('Falta FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEYS. Solo en local puede usarse la clave de desarrollo con --allow-dev-key.');
  }
  if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1 || BATCH_SIZE > 5000) throw new Error('--batch-size debe estar entre 1 y 5000');
  activeEncryptionKid(); // valida el llavero (lanza si está mal formado)
}

/** Comprueba contra el esquema real que todos los campos del registro existen. */
function schemaFields(): Map<string, Set<string>> {
  const models = new Map<string, Set<string>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const delegate = model.name.charAt(0).toLowerCase() + model.name.slice(1);
    models.set(delegate, new Set(model.fields.map((f) => f.name)));
  }
  return models;
}

function planValue(value: unknown, kind: FieldKind, counters: Counters): unknown | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'string' && isEncryptedValue(value)) {
    let plaintext: string;
    try {
      plaintext = decryptFieldStrict(value); // verifica también la clave configurada
    } catch {
      counters.unreadable++;
      return undefined;
    }
    if (!ROTATE || encryptedValueKid(value) === activeEncryptionKid()) { counters.ok++; return undefined; }
    counters.rotate++;
    return encryptField(plaintext);
  }
  counters.plaintext++;
  if (kind === 'json') return encryptField(JSON.stringify(value));
  return typeof value === 'string' ? encryptField(value) : undefined;
}

async function processModel(prisma: PrismaClient, model: string, fields: { name: string; kind: FieldKind }[], hasUpdatedAt: boolean, write: boolean) {
  const delegate = (prisma as any)[model];
  const counters: Record<string, Counters> = Object.fromEntries(fields.map((f) => [f.name, { scanned: 0, plaintext: 0, rotate: 0, ok: 0, unreadable: 0, written: 0, conflicts: 0 }]));
  const select: Record<string, true> = { id: true, ...Object.fromEntries(fields.map((f) => [f.name, true])) };
  if (hasUpdatedAt) select.updatedAt = true;
  let cursor: string | undefined;

  for (;;) {
    const rows: any[] = await delegate.findMany({ select, orderBy: { id: 'asc' }, take: BATCH_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    const changes: Change[] = [];
    const changedFields: string[][] = [];
    for (const row of rows) {
      const where: Record<string, unknown> = { id: row.id };
      const data: Record<string, unknown> = {};
      const touched: string[] = [];
      for (const field of fields) {
        counters[field.name].scanned++;
        const next = planValue(row[field.name], field.kind, counters[field.name]);
        if (next === undefined) continue;
        data[field.name] = next;
        where[field.name] = field.kind === 'json' ? { equals: row[field.name] } : row[field.name];
        touched.push(field.name);
      }
      if (!touched.length) continue;
      if (hasUpdatedAt) data.updatedAt = row.updatedAt; // no alterar la fecha de modificación
      changes.push({ id: row.id, where, data });
      changedFields.push(touched);
    }

    if (!write || !changes.length) continue;
    const results = await prisma.$transaction(changes.map((c) => delegate.updateMany({ where: c.where, data: c.data })));
    results.forEach((result: { count: number }, i: number) => {
      for (const name of changedFields[i]) {
        if (result.count === 1) counters[name].written++;
        else counters[name].conflicts++;
      }
    });
  }
  return counters;
}

/**
 * ClinicalAssessment: copia las columnas legado en claro (totalScore, severity, riskFlag) al campo
 * cifrado `result` y las deja a NULL, en el mismo UPDATE con compare-and-set sobre los valores
 * leídos. Si la fila ya tiene `result` (p. ej. se relanza), solo vacía el legado cuando coincide
 * exactamente con lo cifrado; si no coincide, no toca nada y lo cuenta como conflicto.
 */
async function migrateAssessmentLegacy(prisma: PrismaClient, write: boolean): Promise<Record<string, Counters>> {
  const c: Counters = { scanned: 0, plaintext: 0, rotate: 0, ok: 0, unreadable: 0, written: 0, conflicts: 0 };
  let cursor: string | undefined;
  for (;;) {
    const rows: any[] = await prisma.clinicalAssessment.findMany({
      select: { id: true, updatedAt: true, result: true, totalScore: true, severity: true, riskFlag: true },
      orderBy: { id: 'asc' }, take: BATCH_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    const changes: Change[] = [];
    for (const row of rows) {
      c.scanned++;
      const hasLegacy = ASSESSMENT_RESULT_LEGACY_FIELDS.some((f) => row[f] !== null && row[f] !== undefined);
      if (!hasLegacy) { if (row.result) c.ok++; continue; }
      const legacy = { totalScore: row.totalScore ?? null, severity: row.severity ?? null, riskFlag: Boolean(row.riskFlag) };
      const where = { id: row.id, result: row.result, totalScore: row.totalScore, severity: row.severity, riskFlag: row.riskFlag };
      const clearLegacy = { totalScore: null, severity: null, riskFlag: null, updatedAt: row.updatedAt };
      if (!row.result) {
        c.plaintext++;
        changes.push({ id: row.id, where, data: { result: encryptAssessmentResult(legacy), ...clearLegacy } });
        continue;
      }
      let current: any;
      try { current = JSON.parse(decryptFieldStrict(row.result)); } catch { c.unreadable++; continue; }
      if (current?.totalScore === legacy.totalScore && current?.severity === legacy.severity && Boolean(current?.riskFlag) === legacy.riskFlag) {
        c.plaintext++;
        changes.push({ id: row.id, where, data: clearLegacy });
      } else {
        c.conflicts++; // result y legado discrepan: no se toca, revisar a mano
      }
    }
    if (!write || !changes.length) continue;
    const results = await prisma.$transaction(changes.map((ch) => prisma.clinicalAssessment.updateMany({ where: ch.where as any, data: ch.data as any })));
    results.forEach((r) => { if (r.count === 1) c.written++; else c.conflicts++; });
  }
  return { 'result←legado(totalScore,severity,riskFlag)': c };
}

async function main() {
  assertConfig();
  const schema = schemaFields();
  const plan = new Map<string, { name: string; kind: FieldKind }[]>();
  for (const [model, names] of Object.entries(ENCRYPTED_TEXT_FIELDS)) plan.set(model, (names as readonly string[]).map((name) => ({ name, kind: 'text' as const })));
  for (const [model, names] of Object.entries(ENCRYPTED_JSON_FIELDS)) plan.set(model, [...(plan.get(model) ?? []), ...(names as readonly string[]).map((name) => ({ name, kind: 'json' as const }))]);

  for (const [model, fields] of plan) {
    const known = schema.get(model);
    const missing = fields.filter((f) => !known?.has(f.name)).map((f) => `${model}.${f.name}`);
    if (missing.length) throw new Error(`El registro de campos cifrados no coincide con el esquema: ${missing.join(', ')}`);
  }

  const prisma = new PrismaClient();
  const report = (title: string, results: [string, Record<string, Counters>][], wrote: boolean) => {
    console.log(title);
    for (const [model, counters] of results) {
      for (const [field, c] of Object.entries(counters)) {
        console.log(`  ${model}.${field}: revisados=${c.scanned} enClaro=${c.plaintext} aRotar=${c.rotate} yaCifrados=${c.ok} ilegibles=${c.unreadable}` + (wrote ? ` escritos=${c.written} conflictos=${c.conflicts}` : ` pendientes=${c.plaintext + c.rotate}`));
      }
    }
  };
  const total = (results: [string, Record<string, Counters>][], key: keyof Counters) =>
    results.reduce((sum, [, counters]) => sum + Object.values(counters).reduce((s, c) => s + c[key], 0), 0);
  try {
    console.log(`encrypt-plaintext-fields: modo=${DRY_RUN ? 'dry-run (no escribe)' : 'escritura'} rotate=${ROTATE} claveActiva=${activeEncryptionKid()} lote=${BATCH_SIZE}`);
    // Pasada 1 (siempre): solo lectura. Cuenta y verifica que todo lo cifrado se puede descifrar.
    const planned: [string, Record<string, Counters>][] = [];
    for (const [model, fields] of plan) planned.push([model, await processModel(prisma, model, fields, schema.get(model)!.has('updatedAt'), false)]);
    planned.push(['clinicalAssessment', await migrateAssessmentLegacy(prisma, false)]);
    const unreadable = total(planned, 'unreadable');
    if (DRY_RUN || unreadable) report('Verificación (sin escribir):', planned, false);
    if (unreadable) {
      console.error(`ERROR: ${unreadable} valor(es) cifrados no se pueden descifrar con las claves configuradas. No se ha escrito nada: revisa FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEYS.`);
      process.exitCode = 2;
      return;
    }
    if (DRY_RUN) return;
    // Pasada 2: escritura por lotes transaccionales.
    const written: [string, Record<string, Counters>][] = [];
    for (const [model, fields] of plan) written.push([model, await processModel(prisma, model, fields, schema.get(model)!.has('updatedAt'), true)]);
    written.push(['clinicalAssessment', await migrateAssessmentLegacy(prisma, true)]);
    report('Resultado:', written, true);
    const conflicts = total(written, 'conflicts');
    if (conflicts) console.log(`AVISO: ${conflicts} valor(es) cambiaron durante la ejecución y no se tocaron; vuelve a lanzar el script.`);
    if (total(written, 'unreadable')) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // Nunca volcar el error de Prisma entero: sus mensajes pueden incluir los argumentos de la
  // consulta (es decir, valores). Solo código o tipo de error.
  let detail = 'error desconocido';
  if (error instanceof Prisma.PrismaClientKnownRequestError) detail = `Prisma ${error.code}`;
  else if (error instanceof Prisma.PrismaClientValidationError) detail = 'validación de Prisma (detalle omitido para no volcar datos)';
  else if (error instanceof Prisma.PrismaClientInitializationError) detail = `no se pudo conectar a la base de datos (${error.errorCode ?? 'sin código'})`;
  else if (error instanceof Error && !(error.constructor.name.startsWith('PrismaClient'))) detail = error.message;
  console.error(`encrypt-plaintext-fields falló: ${detail}`);
  process.exitCode = 1;
});
