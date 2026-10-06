/**
 * Retirada del consentimiento comercial (la persona pide no recibir más comunicaciones). Deja
 * la fecha de retirada y borra también la solicitud. El formulario público no puede hacerlo.
 *
 *   npm run waitlist:withdraw-commercial -- --email persona@example.com
 *
 * Entorno: DATABASE_URL y WAITLIST_SECRET (el de la API), en una ejecución puntual. No imprime el email.
 */
import { withdrawCommercialConsent } from '../../src/waitlist/waitlist-admin';
import { assertEmailLookupConfig, emailArg, runWaitlistCli } from './waitlist-script-utils';

const args = process.argv.slice(2);

runWaitlistCli('waitlist:withdraw-commercial', async (prisma) => {
  const email = emailArg(args);
  assertEmailLookupConfig(args, email);
  const result = await withdrawCommercialConsent(prisma, email);
  console.log(result === 'withdrawn' ? 'Consentimiento comercial retirado.' : 'No hay ninguna alta activa con ese email (revisa que WAITLIST_SECRET sea el de producción).');
  if (result !== 'withdrawn') process.exitCode = 2;
});
