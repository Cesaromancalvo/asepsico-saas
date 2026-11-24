/**
 * Borra un espacio ENTERO del piloto demo (A3: baja o fin de la prueba). Ver
 * prisma/scripts/demo/workspace-purge.ts para qué se borra y qué se conserva.
 *
 *   # 1) SIMULACIÓN: solo cuenta e imprime el id del espacio
 *   DEMO_ENVIRONMENT=true <admins de plataforma>=… npm run db:purge-workspace -- --owner-email titular@dominio
 *   # 2) Borrado: --yes y el id que imprimió la simulación (si no coincide, no se borra nada)
 *   DEMO_ENVIRONMENT=true <admins de plataforma>=… npm run db:purge-workspace -- --owner-email titular@dominio --yes --confirm-workspace-id <id>
 *   # Repetir sobre un espacio ya borrado (p. ej. tras restaurar una copia): solo con --workspace-id
 *   DEMO_ENVIRONMENT=true <admins de plataforma>=… npm run db:purge-workspace -- --workspace-id <id> --again [--yes --confirm-workspace-id <id>]
 *
 * Solo con DEMO_ENVIRONMENT=true exacto (el piloto real tendrá otro procedimiento) y con la variable
 * de administradores de la plataforma definida igual que en la API (platformAdminEmailsEnvName en
 * src/platform/platform-admin.config.ts; vacía si no hay ninguno): nunca se borra un espacio con un
 * administrador de la plataforma. Todo en UNA transacción con evento WORKSPACE_PURGED
 * (solo recuentos). Tras el COMMIT se vuelve a comprobar que no queda nada del espacio.
 * Solo imprime el id del espacio y recuentos: nunca nombres, correos ni claves de almacenamiento.
 *
 * Códigos de salida: 0 bien; 2 negativa (no se ha escrito nada); 3 borrado hecho pero ha aparecido
 * algo después (repetir con --again); 1 error inesperado (no se ha escrito nada).
 */
import { PrismaClient } from '@prisma/client';
import { platformAdminEmailsEnvName, platformAdminEmailsForRefusal } from '../../src/platform/platform-admin.config';
import { assertDemoEnvironment, cliArg, DemoRefusal, parseTargetArgs, resolveDemoTarget, safeErrorMessage } from './demo/demo-guards';
import { assertWorkspacePurgeable, purgeWorkspace, remainingWorkspaceRows, workspacePurgeScope } from './demo/workspace-purge';

const fmt = (counts: Record<string, number>) => Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ') || 'nada';

async function resolveWorkspaceId(prisma: PrismaClient, argv: string[], again: boolean): Promise<string> {
  const args = parseTargetArgs(argv);
  if (!again) return (await resolveDemoTarget(prisma, args)).workspaceId;
  // Un espacio ya borrado no tiene titular: con --again solo se acepta el id exacto.
  if (!args.workspaceId) throw new DemoRefusal('Con --again indica el espacio con --workspace-id <id> (el anotado en ops/registro-piloto.md).');
  const ws = await prisma.workspace.findUnique({ where: { id: args.workspaceId }, select: { id: true } });
  if (!ws) throw new DemoRefusal('Espacio no encontrado.');
  return ws.id;
}

async function main() {
  assertDemoEnvironment();
  const platformAdminEmails = platformAdminEmailsForRefusal();
  if (!platformAdminEmails) {
    throw new DemoRefusal(`Falta ${platformAdminEmailsEnvName}: usa la misma que la API de este entorno (${platformAdminEmailsEnvName}= si no hay ninguno).`);
  }
  const argv = process.argv.slice(2);
  const again = argv.includes('--again');
  const confirmed = argv.includes('--yes') && !argv.includes('--dry-run');
  const confirmId = cliArg(argv, 'confirm-workspace-id')?.trim();
  const prisma = new PrismaClient({ log: [] });
  try {
    const workspaceId = await resolveWorkspaceId(prisma, argv, again);
    const scope = await workspacePurgeScope(prisma, workspaceId, platformAdminEmails);
    const keep = scope.users.filter((u) => u.keep).length;
    console.log(`Espacio ${workspaceId}: ${fmt(scope.counts)}. Referencias de almacenamiento: ${scope.storageReferences}. Usuarios: ${scope.users.length} (${keep} se conservan con id y correo, ${scope.users.length - keep} se borran).`);
    assertWorkspacePurgeable(scope);
    if (!confirmed) {
      console.log(`SIMULACIÓN: no se ha borrado nada. Para borrar el espacio entero, repite con --yes --confirm-workspace-id ${workspaceId}`);
      return;
    }
    if (!confirmId) throw new DemoRefusal('Con --yes hace falta --confirm-workspace-id <id> (el id que imprime la simulación). No se ha borrado nada.');
    if (confirmId !== workspaceId) throw new DemoRefusal('--confirm-workspace-id no coincide con el espacio resuelto. No se ha borrado nada.');

    const summary = await prisma.$transaction((tx) => purgeWorkspace(tx, workspaceId, { platformAdminEmails, again }), { maxWait: 15_000, timeout: 300_000 });
    console.log(`Espacio ${workspaceId} borrado: ${fmt(summary)}. Se conservan sus aceptaciones de condiciones y su auditoría. Anota el id en ops/registro-piloto.md.`);

    // Tras el COMMIT: una petición que ya estaba en curso pudo escribir algo justo antes (Argos, condición 2).
    const left = await remainingWorkspaceRows(prisma, workspaceId);
    if (Object.keys(left).length) {
      console.error(`AVISO: tras el borrado han aparecido filas del espacio en ${Object.keys(left).join(', ')}. Repite con --workspace-id ${workspaceId} --again.`);
      process.exitCode = 3;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`No se ha borrado nada: ${safeErrorMessage(error)}`);
  process.exit(error instanceof DemoRefusal ? 2 : 1);
});
