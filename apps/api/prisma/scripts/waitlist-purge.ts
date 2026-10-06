/**
 * Purga de la lista de espera por plazo de conservación: suprime (vacía todos los datos
 * personales y el hash) las altas creadas hace más de N meses. Ver ops/PILOT_RUNBOOK.md.
 *
 *   npm run waitlist:purge -- --dry-run                      # solo cuenta (12 meses)
 *   npm run waitlist:purge                                   # suprime altas de hace > 12 meses
 *   npm run waitlist:purge -- --older-than-months 0          # todas (3 meses tras el lanzamiento)
 *
 * Entorno: solo DATABASE_URL (no descifra ni calcula hashes). Solo imprime recuentos.
 */
import { PrismaClient } from '@prisma/client';
import { purgeWaitlist } from '../../src/waitlist/waitlist-admin';
import { describeScriptError } from './waitlist-script-utils';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const monthsIndex = args.indexOf('--older-than-months');
const monthsRaw = monthsIndex >= 0 ? args[monthsIndex + 1] : args.find((a) => a.startsWith('--older-than-months='))?.split('=')[1];
const MONTHS = monthsRaw === undefined ? 12 : Number(monthsRaw);

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
  const prisma = new PrismaClient();
  try {
    const count = await purgeWaitlist(prisma, MONTHS, { dryRun: DRY_RUN });
    console.log(DRY_RUN ? `Se suprimirían ${count} alta(s) de hace más de ${MONTHS} mes(es).` : `Suprimidas ${count} alta(s) de hace más de ${MONTHS} mes(es).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`waitlist:purge falló: ${describeScriptError(error)}`);
  process.exitCode = 1;
});
