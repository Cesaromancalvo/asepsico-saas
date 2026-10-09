/**
 * Borra lo sembrado por db:seed-demo-workspace en UN espacio: los pacientes con isDemo=true (y todo
 * lo que cuelga de ellos) y los miembros ficticios (User.isDemo). Nunca toca pacientes ni usuarios
 * sin marca, ni el propio espacio ni a su titular.
 *
 *   DEMO_ENVIRONMENT=true npm run db:purge-demo-workspace -- --owner-email titular@dominio          # solo cuenta
 *   DEMO_ENVIRONMENT=true npm run db:purge-demo-workspace -- --owner-email titular@dominio --yes    # borra
 *
 * Sin --yes solo muestra recuentos. Todo en una transacción con evento DEMO_PURGE (recuentos).
 * Se niega si algún paciente demo tiene facturas que no son borrador (correlatividad).
 * Un usuario demo con registros que deben conservarse (p. ej. su aceptación de condiciones,
 * art. 17.3.e RGPD) no se borra: se le quita del espacio y se le deja sin poder entrar.
 * Los objetos del almacenamiento (documentos y adjuntos) no se pueden borrar desde aquí (la API no
 * tiene cliente de almacenamiento): se listan UNA vez por la terminal para borrarlos a mano y en la
 * auditoría solo quedan su número y huellas SHA-256.
 */
import { PrismaClient } from '@prisma/client';
import { assertDemoEnvironment, DemoRefusal, parseTargetArgs, resolveDemoTarget, safeErrorMessage } from './demo/demo-guards';
import { assertPurgeable, demoPurgeScope, purgeDemoData } from './demo/demo-purge';

async function main() {
  assertDemoEnvironment();
  const argv = process.argv.slice(2);
  const args = parseTargetArgs(argv);
  const confirmed = argv.includes('--yes');
  const prisma = new PrismaClient({ log: [] });
  try {
    const target = await resolveDemoTarget(prisma, args);
    const { workspaceId } = target;
    const preview = await demoPurgeScope(prisma, workspaceId);
    console.log(`Espacio "${target.workspaceName}" (${workspaceId}): ${preview.patientIds.length} pacientes demo, ${preview.processes} procesos, ${preview.sessions} sesiones, ${preview.members.length} miembros demo, ${preview.storageKeys.length} archivos en el almacenamiento.`);
    assertPurgeable(preview);
    if (!confirmed) {
      console.log('Simulación: no se ha borrado nada. Repite con --yes para borrar.');
      return;
    }

    const { counts, storageKeys } = await prisma.$transaction((tx) => purgeDemoData(tx, workspaceId), { maxWait: 15_000, timeout: 180_000 });
    console.log(`Borrado: ${counts.patients} pacientes demo, ${counts.processes} procesos, ${counts.sessions} sesiones, ${counts.draftInvoices} facturas borrador. Miembros demo quitados: ${counts.demoMembersRemoved} (usuarios borrados ${counts.usersDeleted}, conservados sin acceso ${counts.usersDisabled}).`);
    if (storageKeys.length) {
      process.stdout.write(['', 'Objetos del almacenamiento que ya no tienen ficha: bórralos del bucket (se muestran solo ahora):', ...storageKeys.map((k) => `  ${k}`), ''].join('\n') + '\n');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`No se ha borrado nada: ${safeErrorMessage(error)}`);
  process.exit(error instanceof DemoRefusal ? 2 : 1);
});
