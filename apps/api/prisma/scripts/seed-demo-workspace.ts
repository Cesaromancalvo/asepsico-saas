/**
 * Siembra un espacio de DEMOSTRACIÓN con pacientes inventados (piloto demo). Pensado para
 * ejecutarse contra producción por el operador de la plataforma:
 *
 *   read -s DATABASE_URL && export DATABASE_URL
 *   read -s FIELD_ENCRYPTION_KEY && export FIELD_ENCRYPTION_KEY   # la MISMA clave que la API
 *   DEMO_ENVIRONMENT=true npm run db:seed-demo-workspace -- --owner-email titular@dominio
 *   (o --workspace-id <id>)
 *
 * Se niega a escribir si: DEMO_ENVIRONMENT no es "true"; falta la clave de cifrado contra una BD
 * no local o no descifra los datos existentes; el espacio no tiene exactamente un OWNER; o tiene
 * algún paciente NO marcado como demo. Idempotente: no duplica pacientes ni miembros demo ya
 * sembrados (los identifica por isDemo). Todo en una transacción, con evento DEMO_SEED (recuentos).
 *
 * Crea, si no existen, "Recepción Demo" (ASSISTANT) y "Terapeuta Demo" (THERAPIST), y marca al
 * titular como profesional clínico (auditado) para que vea a sus pacientes. Las contraseñas son
 * aleatorias y se muestran UNA vez por la terminal (stdout); nunca se registran en ningún log.
 * Para borrarlo todo: npm run db:purge-demo-workspace (mismo destino).
 */
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { DEMO_PATIENTS } from './demo/demo-dataset';
import {
  ALLOW_FIRST_ENCRYPTED_DATA_FLAG, assertDemoEnvironment, assertEncryptionConfigured, assertEncryptionKeyMatchesDatabase, assertNoRealPatients,
  DemoRefusal, parseTargetArgs, resolveDemoTarget, safeErrorMessage,
} from './demo/demo-guards';
import { DemoCounts, emptyCounts, PortalCredential, randomPassword, randomSuffix, writeDemoPatient } from './demo/demo-writer';

type DemoRole = 'ASSISTANT' | 'THERAPIST';
const DEMO_MEMBERS: Record<DemoRole, { firstName: string; lastName: string; local: string }> = {
  ASSISTANT: { firstName: 'Recepción', lastName: 'Demo', local: 'recepcion.demo' },
  THERAPIST: { firstName: 'Terapeuta', lastName: 'Demo', local: 'terapeuta.demo' },
};

interface StaffCredential { role: DemoRole; name: string; email: string; password: string }

async function main() {
  assertDemoEnvironment();
  assertEncryptionConfigured();
  const args = parseTargetArgs(process.argv.slice(2));
  const prisma = new PrismaClient({ log: [] });
  try {
    const target = await resolveDemoTarget(prisma, args);
    await assertEncryptionKeyMatchesDatabase(prisma, { allowNoSamples: process.argv.includes(ALLOW_FIRST_ENCRYPTED_DATA_FLAG) });
    await assertNoRealPatients(prisma, target.workspaceId);
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      // Se repite dentro de la transacción (un paciente real creado entre medias aborta todo).
      await assertNoRealPatients(tx, target.workspaceId);
      const { workspaceId } = target;

      let ownerMadeClinician = false;
      if (!target.ownerIsClinician) {
        const { count } = await tx.workspaceMember.updateMany({
          where: { id: target.ownerMemberId, workspaceId, role: 'OWNER', isClinician: false },
          data: { isClinician: true },
        });
        if (count !== 1) throw new DemoRefusal('El titular cambió mientras se sembraba: vuelve a intentarlo.');
        await tx.auditLog.create({
          data: {
            workspaceId, actorId: null, action: 'MEMBER_CLINICIAN_CHANGED', entityType: 'WorkspaceMember', entityId: target.ownerMemberId,
            metadata: { userId: target.ownerUserId, role: 'OWNER', from: false, to: true, source: 'db:seed-demo-workspace' },
          },
        });
        ownerMadeClinician = true;
      }

      const staff: StaffCredential[] = [];
      const memberIds: Record<DemoRole, string> = { ASSISTANT: '', THERAPIST: '' };
      const createdMembers: string[] = [];
      for (const role of ['ASSISTANT', 'THERAPIST'] as const) {
        const existing = await tx.workspaceMember.findFirst({ where: { workspaceId, role, user: { isDemo: true } }, select: { userId: true } });
        if (existing) { memberIds[role] = existing.userId; continue; }
        const spec = DEMO_MEMBERS[role];
        const email = `${spec.local}.${randomSuffix()}@example.test`;
        const password = randomPassword();
        const user = await tx.user.create({
          data: { email, passwordHash: await hash(password, 12), firstName: spec.firstName, lastName: spec.lastName, isDemo: true },
          select: { id: true },
        });
        const member = await tx.workspaceMember.create({
          data: { workspaceId, userId: user.id, role, isClinician: role === 'THERAPIST' },
          select: { id: true },
        });
        memberIds[role] = user.id;
        createdMembers.push(member.id);
        staff.push({ role, name: `${spec.firstName} ${spec.lastName}`, email, password });
      }

      const existingPatients = await tx.patient.findMany({ where: { workspaceId, isDemo: true }, select: { firstName: true, lastName: true } });
      const seen = new Set(existingPatients.map((p) => `${p.firstName}\u0000${p.lastName}`));
      const counts: DemoCounts = emptyCounts();
      const portal: PortalCredential[] = [];
      let skipped = 0;
      const ctx = { workspaceId, now, clinicianIds: { OWNER: target.ownerUserId, THERAPIST: memberIds.THERAPIST } };
      for (const [index, spec] of DEMO_PATIENTS.entries()) {
        if (seen.has(`${spec.firstName}\u0000${spec.lastName}`)) { skipped++; continue; }
        const credential = await writeDemoPatient(tx, ctx, spec, index, counts);
        if (credential) portal.push(credential);
      }

      // Solo recuentos e ids técnicos: ni nombres, ni correos, ni contenido.
      await tx.auditLog.create({
        data: {
          workspaceId, actorId: null, action: 'DEMO_SEED', entityType: 'Workspace', entityId: workspaceId,
          metadata: { source: 'db:seed-demo-workspace', ...counts, demoMembersCreated: createdMembers, ownerMadeClinician, existingDemoPatientsSkipped: skipped } as any,
        },
      });
      return { counts, staff, portal, skipped, ownerMadeClinician };
    }, { maxWait: 15_000, timeout: 180_000 });

    const c = result.counts;
    console.log(`Espacio de demostración "${target.workspaceName}" (${target.workspaceId}) sembrado.`);
    console.log(`Pacientes nuevos: ${c.patients} (ya existían: ${result.skipped}). Procesos: ${c.processes.ACTIVE} activos, ${c.processes.PAUSED} en pausa, ${c.processes.CLOSED} cerrados.`);
    console.log(`Sesiones: ${c.sessions.past} pasadas con nota, ${c.sessions.future} futuras. Objetivos: ${c.goals}. Tareas: ${c.tasks}. Escalas: ${c.assessments}. Mensajes: ${c.messages}. Accesos al portal: ${c.portalAccounts}.`);
    if (result.ownerMadeClinician) console.log('El titular se ha marcado como profesional clínico (queda auditado).');
    printCredentials(result.staff, result.portal);
  } finally {
    await prisma.$disconnect();
  }
}

/** Única salida con contraseñas: stdout de la terminal del operador, una sola vez. */
function printCredentials(staff: StaffCredential[], portal: PortalCredential[]) {
  if (!staff.length && !portal.length) {
    console.log('No se ha creado ninguna cuenta nueva: no hay contraseñas que mostrar (las anteriores no se vuelven a mostrar).');
    return;
  }
  const out: string[] = ['', '==== CREDENCIALES (se muestran SOLO ahora; guárdalas en tu gestor y limpia la terminal) ===='];
  for (const s of staff) out.push(`${s.role === 'ASSISTANT' ? 'Recepción (ASSISTANT)' : 'Terapeuta (THERAPIST, pedirá activar MFA)'}: ${s.email}  ${s.password}`);
  for (const p of portal) out.push(`Portal del paciente "${p.patient}" (pedirá cambiar la contraseña): ${p.email}  ${p.password}`);
  out.push('=====================================================================================', '');
  process.stdout.write(out.join('\n') + '\n');
}

main().catch((error) => {
  // Nunca se vuelca el error completo: podría incluir datos de la consulta o la URL de la BD.
  console.error(`No se ha sembrado nada: ${safeErrorMessage(error)}`);
  process.exit(error instanceof DemoRefusal ? 2 : 1);
});
