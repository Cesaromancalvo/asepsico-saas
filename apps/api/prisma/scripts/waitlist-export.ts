/**
 * Exporta la lista de espera (altas no suprimidas) a un CSV DESCIFRADO para contactar.
 *
 *   npm run waitlist:export -- --out ~/Documentos/privado/lista-espera.csv
 *
 * Entorno: DATABASE_URL, WAITLIST_SECRET y las claves de cifrado de la API (FIELD_ENCRYPTION_KEY
 * y/o FIELD_ENCRYPTION_KEYS + FIELD_ENCRYPTION_ACTIVE_KID). Sin claves solo funciona con
 * --allow-dev-key (base de datos local).
 *
 * Garantías: la ruta debe estar FUERA del repositorio; nunca sobrescribe un archivo existente;
 * el archivo se crea con permisos 600; por consola solo salen recuentos, nunca datos. Borra el
 * CSV cuando ya no lo necesites (la política fija plazos de conservación).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { exportWaitlist, resolveExportPath } from '../../src/waitlist/waitlist-admin';
import { describeScriptError } from './waitlist-script-utils';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : args.find((a) => a.startsWith('--out='))?.slice('--out='.length);
const ALLOW_DEV_KEY = args.includes('--allow-dev-key');
const REPO_ROOT = resolve(__dirname, '../../../..');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
  if (!process.env.FIELD_ENCRYPTION_KEY && !process.env.FIELD_ENCRYPTION_KEYS && !ALLOW_DEV_KEY) {
    throw new Error('Falta FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEYS. Solo en local puede usarse la clave de desarrollo con --allow-dev-key.');
  }
  const target = resolveExportPath(out, REPO_ROOT);
  const prisma = new PrismaClient();
  try {
    const { csv, count, unreadable } = await exportWaitlist(prisma);
    writeFileSync(target, csv, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(`Exportadas ${count} alta(s) a ${target}`);
    if (unreadable) {
      console.log(`AVISO: ${unreadable} alta(s) no se pudieron descifrar con las claves configuradas.`);
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`waitlist:export falló: ${describeScriptError(error)}`);
  process.exitCode = 1;
});
