/**
 * Supresión de una persona de la lista de espera (derecho de supresión / retirada del
 * consentimiento). Vacía todos sus datos personales y deja solo la marca deletedAt.
 *
 *   npm run waitlist:delete -- --email persona@example.com
 *
 * Entorno: DATABASE_URL y WAITLIST_SECRET (el mismo que la API: con otro, el email no se
 * encuentra). No hace falta la clave de cifrado: se busca por el hash, no se descifra nada.
 * Por consola solo sale cuántas altas se han suprimido, nunca el email.
 */
import { PrismaClient } from '@prisma/client';
import { deleteWaitlistEntry } from '../../src/waitlist/waitlist-admin';
import { describeScriptError } from './waitlist-script-utils';

const args = process.argv.slice(2);
const emailIndex = args.indexOf('--email');
const email = emailIndex >= 0 ? args[emailIndex + 1] : args.find((a) => a.startsWith('--email='))?.slice('--email='.length);
const ALLOW_DEV_SECRET = args.includes('--allow-dev-secret');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
  if (!process.env.WAITLIST_SECRET && !ALLOW_DEV_SECRET) {
    throw new Error('Falta WAITLIST_SECRET (el de la API). Solo en local puede usarse el de desarrollo con --allow-dev-secret.');
  }
  if (!email || !email.includes('@')) throw new Error('Indica el email con --email <email>');
  const prisma = new PrismaClient();
  try {
    const count = await deleteWaitlistEntry(prisma, email);
    console.log(count ? `Suprimida(s) ${count} alta(s).` : 'No hay ninguna alta activa con ese email (revisa que WAITLIST_SECRET sea el de producción).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`waitlist:delete falló: ${describeScriptError(error)}`);
  process.exitCode = 1;
});
