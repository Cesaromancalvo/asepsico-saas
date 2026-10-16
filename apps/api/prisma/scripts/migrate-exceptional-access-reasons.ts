/**
 * H5 del acceso excepcional (CA5.1): mueve CIFRADOS los motivos antiguos en claro de
 * AuditLog.metadata.reason (acción EXCEPTIONAL_CLINICAL_ACCESS) a ExceptionalAccessJustification
 * y los quita de la metadata. Lógica en src/exceptional-access/legacy-reason-migration.ts.
 *
 *   npm run db:migrate-exceptional-reasons -- --dry-run   # solo cuenta
 *   npm run db:migrate-exceptional-reasons                # migra
 *   Opciones: --batch-size=200 · --allow-dev-key (solo en local)
 *
 * Ejecutar DESPUÉS de `prisma migrate deploy` (necesita la tabla nueva) y con la configuración de
 * claves de la API. Antes de desplegar, Argos y Dora comprueban si hay filas en entornos reales
 * (--dry-run). Nunca imprime el texto, solo recuentos.
 */
import { PrismaClient } from '@prisma/client';
import { activeEncryptionKid } from '../../src/common/crypto/field-encryption';
import { migrateLegacyExceptionalReasons } from '../../src/exceptional-access/legacy-reason-migration';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ALLOW_DEV_KEY = args.includes('--allow-dev-key');
const BATCH_SIZE = Number(args.find((a) => a.startsWith('--batch-size='))?.split('=')[1] ?? 200);

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
  const hasKey = Boolean(process.env.FIELD_ENCRYPTION_KEY || process.env.FIELD_ENCRYPTION_KEYS);
  if (!hasKey && !ALLOW_DEV_KEY && !DRY_RUN) {
    throw new Error('Falta FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEYS. Solo en local puede usarse la clave de desarrollo con --allow-dev-key.');
  }
  if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1 || BATCH_SIZE > 5000) throw new Error('--batch-size debe estar entre 1 y 5000');
  activeEncryptionKid();
  const prisma = new PrismaClient();
  try {
    const result = await migrateLegacyExceptionalReasons(prisma, { dryRun: DRY_RUN, batchSize: BATCH_SIZE });
    console.log(`${DRY_RUN ? '[dry-run] ' : ''}Registros con motivo en claro: ${result.found} · migrados: ${result.migrated} · omitidos (sin paciente o actor): ${result.skipped}`);
    if (result.skipped) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Error desconocido');
  process.exitCode = 1;
});
