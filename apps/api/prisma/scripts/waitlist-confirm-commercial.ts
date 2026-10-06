/**
 * Doble opt-in manual del consentimiento comercial: ejecutar SOLO cuando la persona haya
 * respondido "Sí" al email de confirmación. Conserva ese email de respuesta como prueba.
 *
 *   npm run waitlist:confirm-commercial -- --email persona@example.com
 *
 * Entorno: DATABASE_URL y WAITLIST_SECRET (el de la API), en una ejecución puntual. Solo confirma
 * si la persona marcó la casilla en el formulario. No imprime el email.
 */
import { confirmCommercialConsent } from '../../src/waitlist/waitlist-admin';
import { assertEmailLookupConfig, emailArg, runWaitlistCli } from './waitlist-script-utils';

const args = process.argv.slice(2);
const MESSAGES = {
  confirmed: 'Consentimiento comercial confirmado.',
  'not-requested': 'NO confirmado: esa alta no marcó la casilla comercial (o la retiró).',
  'not-found': 'No hay ninguna alta activa con ese email (revisa que WAITLIST_SECRET sea el de producción).',
  withdrawn: '',
} as const;

runWaitlistCli('waitlist:confirm-commercial', async (prisma) => {
  const email = emailArg(args);
  assertEmailLookupConfig(args, email);
  const result = await confirmCommercialConsent(prisma, email);
  console.log(MESSAGES[result]);
  if (result !== 'confirmed') process.exitCode = 2;
});
