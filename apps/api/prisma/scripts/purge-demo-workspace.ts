/**
 * Borra lo sembrado por db:seed-demo-workspace en UN espacio: los pacientes con isDemo=true (y todo
 * lo que cuelga de ellos) y los miembros ficticios (User.isDemo). Nunca toca pacientes ni usuarios
 * sin marca, ni el propio espacio ni a su titular.
 *
 *   DEMO_ENVIRONMENT=true npm run db:purge-demo-workspace -- --owner-email titular@dominio          # solo cuenta
 *   DEMO_ENVIRONMENT=true npm run db:purge-demo-workspace -- --owner-email titular@dominio --yes    # borra
 *
 * Sin --yes solo muestra recuentos. Todo en una transacción con evento DEMO_PURGE (recuentos).
 * Un usuario demo que tenga registros que deben conservarse (p. ej. su aceptación de condiciones,
 * art. 17.3.e RGPD) no se borra: se le quita del espacio y se le deja sin poder entrar.
 */
import { randomBytes } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertDemoEnvironment, DemoRefusal, parseTargetArgs, resolveDemoTarget, safeErrorMessage } from './demo/demo-guards';

type Tx = Prisma.TransactionClient;

async function demoScope(db: Tx | PrismaClient, workspaceId: string) {
  const patients = await db.patient.findMany({ where: { workspaceId, isDemo: true }, select: { id: true } });
  const members = await db.workspaceMember.findMany({ where: { workspaceId, user: { isDemo: true } }, select: { id: true, userId: true } });
  const patientIds = patients.map((p) => p.id);
  const inPatients = { workspaceId, patientId: { in: patientIds } };
  const [sessions, processes, filesInStorage] = await Promise.all([
    db.session.count({ where: inPatients }),
    db.clinicalProcess.count({ where: inPatients }),
    db.patientDocument.count({ where: { ...inPatients, storageKey: { not: null } } }),
  ]);
  return { patientIds, members, sessions, processes, filesInStorage };
}

/** Registros que impiden borrar a un usuario demo (FK RESTRICT o evidencia que se conserva). */
async function userIsReferenced(tx: Tx, userId: string): Promise<boolean> {
  const counts = await Promise.all([
    tx.session.count({ where: { therapistId: userId } }),
    tx.clinicalProcess.count({ where: { therapistId: userId } }),
    tx.termsAcceptance.count({ where: { userId } }),
    tx.therapeuticResource.count({ where: { createdById: userId } }),
    tx.patientDocument.count({ where: { createdById: userId } }),
    tx.consentRecord.count({ where: { createdById: userId } }),
    tx.clinicalReport.count({ where: { createdById: userId } }),
    tx.invoice.count({ where: { createdById: userId } }),
    tx.payment.count({ where: { recordedById: userId } }),
    tx.workspaceMember.count({ where: { userId } }),
  ]);
  return counts.some((n) => n > 0);
}

async function main() {
  assertDemoEnvironment();
  const argv = process.argv.slice(2);
  const args = parseTargetArgs(argv);
  const confirmed = argv.includes('--yes');
  const prisma = new PrismaClient({ log: [] });
  try {
    const target = await resolveDemoTarget(prisma, args);
    const { workspaceId } = target;
    const preview = await demoScope(prisma, workspaceId);
    console.log(`Espacio "${target.workspaceName}" (${workspaceId}): ${preview.patientIds.length} pacientes demo, ${preview.processes} procesos, ${preview.sessions} sesiones, ${preview.members.length} miembros demo.`);
    if (preview.filesInStorage) console.log(`Aviso: ${preview.filesInStorage} documentos de pacientes demo tienen archivo en el almacenamiento; se borra la ficha, no el archivo.`);
    if (!confirmed) {
      console.log('Simulación: no se ha borrado nada. Repite con --yes para borrar.');
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const scope = await demoScope(tx, workspaceId);
      const inPatients = { workspaceId, patientId: { in: scope.patientIds } };
      // Hijos con FK RESTRICT hacia Patient, siempre acotados al workspace y a pacientes demo.
      const payments = await tx.payment.deleteMany({ where: inPatients });
      const invoices = await tx.invoice.deleteMany({ where: inPatients });
      const sessions = await tx.session.deleteMany({ where: inPatients });
      const processes = await tx.clinicalProcess.deleteMany({ where: inPatients });
      const notifications = await tx.notification.deleteMany({ where: inPatients });
      await tx.notificationPreference.deleteMany({ where: inPatients });
      // El resto (historia, objetivos, tareas, escalas, documentos, consentimientos, informes,
      // portal, recursos compartidos, conversaciones y mensajes) cae en cascada con el paciente.
      const patients = await tx.patient.deleteMany({ where: { workspaceId, isDemo: true, id: { in: scope.patientIds } } });

      let usersDeleted = 0;
      let usersDisabled = 0;
      for (const member of scope.members) {
        await tx.workspaceMember.deleteMany({ where: { id: member.id, workspaceId } });
        await tx.refreshToken.updateMany({ where: { userId: member.userId, revokedAt: null }, data: { revokedAt: new Date() } });
        if (await userIsReferenced(tx, member.userId)) {
          // Hash inválido para bcrypt: ninguna contraseña coincide. Sin MFA ni sesiones vivas.
          await tx.user.updateMany({
            where: { id: member.userId, isDemo: true },
            data: { passwordHash: `!disabled-demo-${randomBytes(16).toString('hex')}`, totpEnabled: false, totpSecret: null, mfaRecoveryCodes: [] },
          });
          usersDisabled++;
        } else {
          usersDeleted += (await tx.user.deleteMany({ where: { id: member.userId, isDemo: true } })).count;
        }
      }

      const counts = {
        patients: patients.count, sessions: sessions.count, processes: processes.count, invoices: invoices.count,
        payments: payments.count, notifications: notifications.count, demoMembersRemoved: scope.members.length, usersDeleted, usersDisabled,
      };
      await tx.auditLog.create({
        data: { workspaceId, actorId: null, action: 'DEMO_PURGE', entityType: 'Workspace', entityId: workspaceId, metadata: { source: 'db:purge-demo-workspace', ...counts } },
      });
      return counts;
    }, { maxWait: 15_000, timeout: 180_000 });

    console.log(`Borrado: ${result.patients} pacientes demo, ${result.processes} procesos, ${result.sessions} sesiones. Miembros demo quitados: ${result.demoMembersRemoved} (usuarios borrados ${result.usersDeleted}, conservados sin acceso ${result.usersDisabled}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`No se ha borrado nada: ${safeErrorMessage(error)}`);
  process.exit(error instanceof DemoRefusal ? 2 : 1);
});
