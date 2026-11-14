/**
 * E1 · Carga del conjunto FIJO de datos de ejemplo en un espacio recién registrado del piloto demo.
 *
 * - Una sola transacción: o se carga todo o nada.
 * - Idempotente: compare-and-set sobre Workspace.sampleDataLoadedAt (nulo → ahora). Una segunda
 *   llamada (o una en paralelo) no escribe nada.
 * - Solo en un espacio con exactamente un OWNER activo (quien se acaba de registrar) y SIN pacientes
 *   reales (isDemo=false): si no, se niega y no escribe nada.
 * - Todo lo escrito lleva el workspaceId del espacio y los pacientes van marcados con isDemo=true.
 * - La contraseña del paciente de prueba es aleatoria y se DESCARTA aquí: no va a ningún log, correo
 *   ni auditoría. El titular obtiene una nueva con POST /sample-data/portal-access.
 * - Auditoría SAMPLE_DATA_LOADED con recuentos e ids técnicos (sin nombres, correos ni contenido).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { SAMPLE_PATIENTS } from './demo-dataset';
import { emptyCounts, writeDemoPatient } from './demo-writer';
import { DemoRefusal } from './sample-data-purge';

export const SAMPLE_DATA_LOADED = 'SAMPLE_DATA_LOADED';

export interface LoadSampleDataInput {
  workspaceId: string;
  ownerUserId: string;
  registrationInviteId: string;
  now?: Date;
}

export type LoadSampleDataResult =
  | { loaded: true; counts: ReturnType<typeof emptyCounts>; ownerMadeClinician: boolean }
  | { loaded: false; reason: 'ALREADY_LOADED' };

export async function loadSampleData(prisma: PrismaClient, input: LoadSampleDataInput): Promise<LoadSampleDataResult> {
  const now = input.now ?? new Date();
  const { workspaceId, ownerUserId } = input;
  return prisma.$transaction(async (tx) => {
    const claim = await tx.workspace.updateMany({ where: { id: workspaceId, sampleDataLoadedAt: null }, data: { sampleDataLoadedAt: now } });
    if (claim.count !== 1) return { loaded: false as const, reason: 'ALREADY_LOADED' as const };

    const owners = await tx.workspaceMember.findMany({ where: { workspaceId, role: 'OWNER' }, select: { id: true, userId: true, isClinician: true, status: true } });
    if (owners.length !== 1 || owners[0].userId !== ownerUserId || owners[0].status !== 'ACTIVE') {
      throw new DemoRefusal('El espacio no tiene exactamente un titular activo: no se cargan datos de ejemplo.');
    }
    if ((await tx.patient.count({ where: { workspaceId, isDemo: false } })) > 0) {
      throw new DemoRefusal('El espacio ya tiene pacientes: no se cargan datos de ejemplo.');
    }

    // El titular tiene que ser profesional clínico para ver el contenido de sus pacientes de ejemplo
    // (proceso, notas, tareas por revisar). Igual que db:seed-demo-workspace, auditado.
    const owner = owners[0];
    const ownerMadeClinician = !owner.isClinician;
    if (ownerMadeClinician) await makeOwnerClinician(tx, workspaceId, owner.id, ownerUserId);

    const counts = emptyCounts();
    const ctx = { workspaceId, now, clinicianIds: { OWNER: ownerUserId, THERAPIST: ownerUserId } };
    for (const [index, spec] of SAMPLE_PATIENTS.entries()) {
      // La credencial devuelta se descarta a propósito (ver cabecera).
      await writeDemoPatient(tx, ctx, spec, index, counts);
    }

    await tx.auditLog.create({
      data: {
        workspaceId, actorId: null, action: SAMPLE_DATA_LOADED, entityType: 'Workspace', entityId: workspaceId,
        metadata: { source: 'registration', dataset: 'E1', registrationInviteId: input.registrationInviteId, ownerMadeClinician, ...counts } as unknown as Prisma.InputJsonValue,
      },
    });
    return { loaded: true as const, counts, ownerMadeClinician };
  }, { maxWait: 10_000, timeout: 60_000 });
}

async function makeOwnerClinician(tx: Prisma.TransactionClient, workspaceId: string, memberId: string, userId: string) {
  const { count } = await tx.workspaceMember.updateMany({
    where: { id: memberId, workspaceId, role: 'OWNER', isClinician: false },
    data: { isClinician: true },
  });
  if (count !== 1) throw new DemoRefusal('El titular cambió mientras se cargaban los datos de ejemplo.');
  await tx.auditLog.create({
    data: {
      workspaceId, actorId: null, action: 'MEMBER_CLINICIAN_CHANGED', entityType: 'WorkspaceMember', entityId: memberId,
      metadata: { userId, role: 'OWNER', from: false, to: true, source: 'sample-data:E1' },
    },
  });
}
