import type { LegalDocument } from '../legal/legal-documents';

/**
 * ¿Se cargan datos de ejemplo (E1) en el espacio que se acaba de registrar?
 *
 * Cómo se distingue hoy un espacio del piloto demo: no hay un "tipo de espacio" en la BD. El piloto
 * demo es un DESPLIEGUE entero (DEMO_ENVIRONMENT; la web pinta el aviso "Entorno de prueba") cuyos
 * profesionales aceptan las condiciones del piloto demo (versiones `demo-*`: PILOT_TERMS demo-1.1,
 * PRIVACY_PRODUCT demo-1.3) y que entran por invitación de registro (registro cerrado). E1 añade la
 * marca explícita en la invitación (RegistrationInvite.withSampleData), que solo pone el CLI del
 * operador en ese entorno.
 *
 * Falla en cerrado: hacen falta las TRES a la vez.
 *  1. La invitación usada lleva withSampleData = true.
 *  2. DEMO_ENVIRONMENT es "true" EXACTO (más estricto que el aviso de la web, igual que los scripts
 *     db:seed-demo-workspace / db:purge-demo-workspace).
 *  3. Todas las condiciones vigentes que se acaban de aceptar son del piloto demo (versión `demo-*`):
 *     si algún día se publican las del piloto real y alguien olvida cambiar DEMO_ENVIRONMENT, no se
 *     siembra nada.
 * Los miembros invitados por el titular (registerMember) nunca disparan la carga.
 */
export function shouldLoadSampleData(
  invite: { withSampleData?: boolean | null },
  docs: readonly Pick<LegalDocument, 'version'>[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (invite.withSampleData !== true) return false;
  if (env.DEMO_ENVIRONMENT !== 'true') return false;
  return docs.length > 0 && docs.every((d) => /^demo-/.test(d.version));
}
