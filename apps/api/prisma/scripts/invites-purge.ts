/**
 * Borra las invitaciones de registro SIN USAR que han caducado o se han revocado (Argos 23/11/2026,
 * punto 3). Así el correo de quien no llegó a registrarse no se guarda más allá del plazo comprometido.
 * Las usadas y las vigentes nunca se tocan. Ver ops/PILOT_RUNBOOK.md.
 *
 *   npm run invites:purge                # SIMULACIÓN (por defecto): solo cuenta
 *   npm run invites:purge -- --dry-run   # lo mismo, explícito
 *   npm run invites:purge -- --yes       # borra, en una transacción
 *
 * Entorno: solo DATABASE_URL. Solo imprime recuentos: nunca correos ni ids.
 * Pensado para ejecutarse cada lunes (o como cron de Render).
 */
import { PrismaClient } from '@prisma/client';
import { purgeStaleRegistrationInvites } from '../../src/auth/registration-invite-purge';
import { describeScriptError } from './waitlist-script-utils';

const args = process.argv.slice(2);
// --dry-run gana a --yes: ante la duda, no se borra nada.
const APPLY = args.includes('--yes') && !args.includes('--dry-run');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
  const prisma = new PrismaClient();
  try {
    const r = await purgeStaleRegistrationInvites(prisma, { apply: APPLY });
    const detail = `${r.expired} caducada(s) y ${r.revoked} revocada(s) sin caducar`;
    if (!APPLY) {
      console.log(`SIMULACIÓN: se borrarían ${r.total} invitación(es) sin usar (${detail}). Repite con --yes para borrarlas.`);
    } else {
      console.log(`Borradas ${r.total} invitación(es) sin usar (${detail}).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`invites:purge falló: ${describeScriptError(error)}`);
  process.exitCode = 1;
});
