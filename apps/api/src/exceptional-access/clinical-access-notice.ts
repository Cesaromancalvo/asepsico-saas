import { Prisma } from '@prisma/client';
import { ROLE_LABELS, patientInitials } from './exceptional-access.policy';

/**
 * Aviso en la app al terapeuta titular (CA3.1, CA6.3): persona, rol, iniciales del paciente y
 * motivo en lenguaje claro. Nunca la explicación, nunca texto clínico, nunca email.
 * Se escribe dentro de la transacción del acceso o de la apertura.
 */

type NoticeTx = Pick<Prisma.TransactionClient, 'clinicalProcess' | 'workspaceMember' | 'user' | 'notification'>;

/**
 * Autores de procesos del paciente que siguen siendo miembros del workspace, excluyendo los ids
 * indicados (quien actúa, el profesional destino...). Solo dentro del workspace.
 */
export async function currentAuthorsOfPatient(tx: NoticeTx, workspaceId: string, patientId: string, exclude: string[]): Promise<string[]> {
  const processes = await tx.clinicalProcess.findMany({
    where: { workspaceId, patientId, therapistId: { notIn: exclude } },
    select: { therapistId: true },
  });
  const authorIds = [...new Set(processes.map((row) => row.therapistId))];
  if (!authorIds.length) return [];
  const members = await tx.workspaceMember.findMany({ where: { workspaceId, userId: { in: authorIds }, status: 'ACTIVE' }, select: { userId: true } });
  const memberIds = new Set(members.map((row) => row.userId));
  return authorIds.filter((id) => memberIds.has(id));
}

export interface NoticeInput {
  workspaceId: string;
  recipientIds: string[];
  actorId: string;
  actorRole: string;
  patient: { id: string; firstName?: string | null; lastName?: string | null };
  /** Verbo de la frase: "abrió la historia de", "ha abierto un proceso con"... */
  action: string;
  reasonLabel: string;
  title: string;
  /** Clave estable del evento (id del acceso o de la apertura) para no duplicar avisos. */
  eventKey: string;
  now: Date;
}

export async function sendClinicalAccessNotices(tx: NoticeTx, input: NoticeInput): Promise<number> {
  if (!input.recipientIds.length) return 0;
  const actor = await tx.user.findFirst({ where: { id: input.actorId }, select: { firstName: true, lastName: true } });
  const actorName = actor ? `${actor.firstName} ${actor.lastName}`.trim() : 'Un miembro de la consulta';
  const roleLabel = ROLE_LABELS[input.actorRole] ?? input.actorRole;
  const when = input.now.toISOString();
  const body = `El ${when}, ${actorName} (${roleLabel}) ${input.action} ${patientInitials(input.patient)} por: ${input.reasonLabel}.`;
  const result = await tx.notification.createMany({
    data: input.recipientIds.map((userId) => ({
      workspaceId: input.workspaceId,
      audience: 'PROFESSIONAL' as const,
      userId,
      type: 'CLINICAL_ACCESS_NOTICE' as const,
      title: input.title,
      body,
      actionUrl: `/patients/${input.patient.id}`,
      status: 'SENT' as const,
      scheduledAt: input.now,
      sentAt: input.now,
      dedupeKey: `${input.eventKey}:${userId}`,
    })),
    skipDuplicates: true,
  });
  return result.count;
}
