import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { currentAuthorsOfPatient, sendClinicalAccessNotices } from '../exceptional-access/clinical-access-notice';
import {
  OWNER_REVIEW_WINDOW_MS,
  PROCESS_OPENING_REASON_LABELS,
  ProcessOpeningReasonCode,
  isProcessOpeningReason,
} from '../exceptional-access/exceptional-access.policy';

/**
 * H6 — Cerrar el atajo de abrirse o reactivar un proceso sobre historia ajena
 * (docs/producto/acceso-excepcional.md §3.8 y §4 H6, mecanismo de Argos).
 *
 * Todo se ejecuta DENTRO de la transacción del alta o de la reactivación:
 *  1. `pg_advisory_xact_lock` por (workspace, paciente): dos aperturas simultáneas sobre el mismo
 *     paciente se serializan, y la segunda ya ve el proceso de la primera (CA6.8).
 *  2. ¿Historia ajena? = algún proceso del paciente (cualquier estado, mismo workspace) cuyo autor
 *     no es el profesional destino. En reactivación, solo procesos de otros autores POSTERIORES al
 *     que se reactiva (CA6.7).
 *  3. Decisión por el rol de la BD (no el del token): THERAPIST/otro → denegado (403 auditado por el
 *     llamador, fuera de la transacción para que la auditoría no se revierta); OWNER/ADMIN → código
 *     obligatorio (400 OPENING_REASON_REQUIRED).
 */

export const OPENING_REASON_REQUIRED = 'OPENING_REASON_REQUIRED';

/** Resultado de la comprobación. `denied` lo convierte el llamador en 403 auditado. */
export type OpeningDecision =
  | { kind: 'NORMAL' }
  | { kind: 'DENIED' }
  | { kind: 'OVER_HISTORY'; reasonCode: ProcessOpeningReasonCode; actorRole: 'OWNER' | 'ADMIN' };

/** Error interno para salir de la transacción (revirtiéndola) y auditar el 403 fuera. */
export class OpeningDeniedSignal extends Error {
  constructor(readonly patientId: string) {
    super('OPENING_DENIED');
  }
}

type OpeningTx = Prisma.TransactionClient;

export async function lockPatientForOpening(tx: OpeningTx, workspaceId: string, patientId: string) {
  // Mismo patrón que billing.service.ts. Namespace propio para no colisionar con otros locks.
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `asepsico:process-opening:${workspaceId}:${patientId}`);
}

export async function hasForeignHistory(
  tx: OpeningTx,
  params: { workspaceId: string; patientId: string; targetTherapistId: string; createdAfter?: Date; excludeProcessId?: string },
): Promise<boolean> {
  const foreign = await tx.clinicalProcess.findFirst({
    where: {
      workspaceId: params.workspaceId,
      patientId: params.patientId,
      therapistId: { not: params.targetTherapistId },
      ...(params.createdAfter ? { createdAt: { gt: params.createdAfter } } : {}),
      ...(params.excludeProcessId ? { id: { not: params.excludeProcessId } } : {}),
    },
    select: { id: true },
  });
  return Boolean(foreign);
}

/**
 * Decide qué pasa con una apertura/reactivación sobre un paciente con o sin historia ajena.
 * Lanza 400 (sin código, o código fuera del catálogo) y señala la denegación con DENIED.
 */
export async function decideOpening(
  tx: OpeningTx,
  actor: AuthUser,
  workspaceId: string,
  foreignHistory: boolean,
  openingReasonCode: unknown,
): Promise<OpeningDecision> {
  if (!foreignHistory) return { kind: 'NORMAL' };
  const member = await tx.workspaceMember.findFirst({ where: { workspaceId, userId: actor.sub }, select: { role: true } });
  const role = member?.role;
  if (role !== 'OWNER' && role !== 'ADMIN') return { kind: 'DENIED' };
  if (openingReasonCode === undefined || openingReasonCode === null) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: OPENING_REASON_REQUIRED,
      message: 'Este paciente tiene historia con otro profesional: indica el motivo de apertura',
    });
  }
  if (!isProcessOpeningReason(openingReasonCode)) {
    throw new BadRequestException('Motivo de apertura no válido');
  }
  return { kind: 'OVER_HISTORY', reasonCode: openingReasonCode, actorRole: role };
}

/**
 * Registra una apertura/reactivación sobre historia ajena ya permitida: registro de apertura
 * (con revisión en 72 h si es autoasignada), auditoría solo con códigos y avisos a los autores
 * anteriores que sigan siendo miembros. Misma transacción que el proceso.
 */
export async function recordOpeningOverHistory(
  tx: OpeningTx,
  params: {
    workspaceId: string;
    actor: AuthUser;
    actorRole: 'OWNER' | 'ADMIN';
    patientId: string;
    clinicalProcessId: string;
    targetTherapistId: string;
    reasonCode: ProcessOpeningReasonCode;
    kind: 'OPENED' | 'REACTIVATED';
    now: Date;
  },
) {
  const { workspaceId, actor, patientId, targetTherapistId, reasonCode, now } = params;
  const selfAssigned = targetTherapistId === actor.sub;
  const ownerCountAtCreation = await tx.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
  const opening = await tx.clinicalProcessOpening.create({
    data: {
      workspaceId,
      patientId,
      clinicalProcessId: params.clinicalProcessId,
      actorId: actor.sub,
      actorRole: params.actorRole,
      targetTherapistId,
      kind: params.kind,
      reasonCode,
      selfAssigned,
      ownerCountAtCreation,
      // Control posterior solo si se lo abrió a sí mismo (CA6.6); el sustituto no (CA6.5).
      ownerReviewDueAt: selfAssigned ? new Date(now.getTime() + OWNER_REVIEW_WINDOW_MS) : null,
      createdAt: now,
    },
    select: { id: true },
  });
  await tx.auditLog.create({
    data: {
      workspaceId,
      actorId: actor.sub,
      action: 'CLINICAL_PROCESS_OPENED_OVER_HISTORY',
      entityType: 'ClinicalProcess',
      entityId: params.clinicalProcessId,
      // CA6.3: SOLO estos tres campos. Nada de texto.
      metadata: { reasonCode, targetTherapistId, selfAssigned },
    },
  });
  const patient = await tx.patient.findFirst({ where: { id: patientId, workspaceId }, select: { id: true, firstName: true, lastName: true } });
  const recipients = await currentAuthorsOfPatient(tx, workspaceId, patientId, [targetTherapistId, actor.sub]);
  await sendClinicalAccessNotices(tx, {
    workspaceId,
    recipientIds: recipients,
    actorId: actor.sub,
    actorRole: params.actorRole,
    patient: patient ?? { id: patientId },
    action: params.kind === 'OPENED' ? 'ha abierto un proceso con' : 'ha reactivado un proceso con',
    reasonLabel: PROCESS_OPENING_REASON_LABELS[reasonCode],
    title: 'Apertura de proceso sobre tu paciente',
    eventKey: `process-opening:${opening.id}`,
    now,
  });
  return { openingId: opening.id, selfAssigned };
}
