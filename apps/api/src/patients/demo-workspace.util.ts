import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isDemoEnvironment } from '../health/environment.controller';

export const DEMO_MEMBERS_ACTIVE = 'DEMO_MEMBERS_ACTIVE';

/**
 * Condición de Argos: las cuentas ficticias del espacio de demostración (Recepción Demo, Terapeuta
 * Demo; User.isDemo) no pueden convivir con pacientes reales. En un entorno que NO es de
 * demostración (DEMO_ENVIRONMENT=false, piloto con pacientes reales), la API se niega a dar de alta
 * pacientes en un espacio que aún tenga miembros demo: hay que ejecutar antes
 * `npm run db:purge-demo-workspace`.
 *
 * En el entorno de demostración (DEMO_ENVIRONMENT distinto de "false") se permite: las condiciones
 * del piloto demo solo admiten pacientes inventados, y los invitados deben poder crear los suyos.
 */
export async function assertNoActiveDemoMembers(db: Prisma.TransactionClient, workspaceId: string, env: NodeJS.ProcessEnv = process.env) {
  if (isDemoEnvironment(env)) return;
  const demoMembers = await db.workspaceMember.count({ where: { workspaceId, user: { isDemo: true } } });
  if (demoMembers > 0) {
    throw new ConflictException({
      statusCode: 409,
      code: DEMO_MEMBERS_ACTIVE,
      message: 'Este espacio aún tiene cuentas de demostración. Ejecuta el borrado del espacio demo (db:purge-demo-workspace) antes de dar de alta pacientes.',
    });
  }
}
