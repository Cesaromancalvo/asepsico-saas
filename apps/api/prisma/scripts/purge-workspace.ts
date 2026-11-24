/**
 * Borra un espacio ENTERO del piloto demo (A3: baja o fin de la prueba). Ver
 * prisma/scripts/demo/workspace-purge.ts para qué se borra y qué se conserva.
 *
 *   DEMO_ENVIRONMENT=true npm run db:purge-workspace -- --owner-email titular@dominio          # SIMULACIÓN: solo cuenta
 *   DEMO_ENVIRONMENT=true npm run db:purge-workspace -- --workspace-id <id>                    # SIMULACIÓN
 *   DEMO_ENVIRONMENT=true npm run db:purge-workspace -- --owner-email titular@dominio --yes    # borra
 *
 * Solo con DEMO_ENVIRONMENT=true exacto (el piloto real tendrá otro procedimiento). Todo en UNA
 * transacción con evento WORKSPACE_PURGED (solo recuentos). Solo imprime el id del espacio y
 * recuentos: nunca nombres, correos ni claves de almacenamiento. Anotar el id en
 * ops/registro-piloto.md: si se restaura una copia, hay que volver a borrarlo.
 */
import { PrismaClient } from '@prisma/client';
import { assertDemoEnvironment, DemoRefusal, parseTargetArgs, resolveDemoTarget, safeErrorMessage } from './demo/demo-guards';
import { assertWorkspacePurgeable, purgeWorkspace, workspacePurgeScope } from './demo/workspace-purge';

const fmt = (counts: Record<string, number>) => Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ') || 'nada';

async function main() {
  assertDemoEnvironment();
  const argv = process.argv.slice(2);
  const args = parseTargetArgs(argv);
  const confirmed = argv.includes('--yes') && !argv.includes('--dry-run');
  const prisma = new PrismaClient({ log: [] });
  try {
    const { workspaceId } = await resolveDemoTarget(prisma, args);
    const scope = await workspacePurgeScope(prisma, workspaceId);
    const keep = scope.users.filter((u) => u.keep).length;
    console.log(`Espacio ${workspaceId}: ${fmt(scope.counts)}. Referencias de almacenamiento: ${scope.storageReferences}. Usuarios: ${scope.users.length} (${keep} se conservan con id y correo, ${scope.users.length - keep} se borran).`);
    assertWorkspacePurgeable(scope);
    if (!confirmed) {
      console.log('SIMULACIÓN: no se ha borrado nada. Repite con --yes para borrar el espacio entero.');
      return;
    }
    const summary = await prisma.$transaction((tx) => purgeWorkspace(tx, workspaceId), { maxWait: 15_000, timeout: 300_000 });
    console.log(`Espacio ${workspaceId} borrado: ${fmt(summary)}. Se conservan sus aceptaciones de condiciones y su auditoría. Anota el id en ops/registro-piloto.md.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`No se ha borrado nada: ${safeErrorMessage(error)}`);
  process.exit(error instanceof DemoRefusal ? 2 : 1);
});
