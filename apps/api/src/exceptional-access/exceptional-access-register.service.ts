import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { decryptField } from '../common/crypto/field-encryption';
import { ClinicalAccessService } from '../clinical-access/clinical-access.service';
import { DEFERRED_NOTICE_REMINDER_MS, ExceptionalAccessReasonCode, reviewPermission } from './exceptional-access.policy';
import { BLOCKED_READ_PURPOSES, JustificationReadPurposeValue } from './dto/exceptional-access.dto';
import { notifyAuthors } from './exceptional-access.service';

/** Columnas del registro SIN texto (ni explicación ni motivo de diferimiento). */
const ACCESS_LIST_SELECT = {
  id: true, patientId: true, actorId: true, actorRole: true, reasonCode: true, createdAt: true, expiresAt: true,
  closedAt: true, closeReason: true, ownerReviewDueAt: true, reviewedAt: true, reviewedById: true, reviewOutcome: true,
  selfReview: true, notificationDeferredAt: true, notificationReleasedAt: true, blockedAt: true, clinicalTermWarningIgnored: true,
  migratedFromAuditLogId: true,
} as const;

const OPENING_LIST_SELECT = {
  id: true, patientId: true, clinicalProcessId: true, actorId: true, actorRole: true, targetTherapistId: true, kind: true,
  reasonCode: true, selfAssigned: true, ownerReviewDueAt: true, reviewedAt: true, reviewedById: true, reviewOutcome: true,
  selfReview: true, createdAt: true,
} as const;

type AccessRow = { closedAt: Date | null; expiresAt: Date; blockedAt: Date | null; ownerReviewDueAt: Date | null; reviewedAt: Date | null; notificationDeferredAt: Date | null; notificationReleasedAt: Date | null; migratedFromAuditLogId: string | null };

/** Estado para la pantalla del OWNER (§3.7). */
export function accessStatus(row: AccessRow, now = new Date()): 'BLOCKED' | 'URGENCY_PENDING_REVIEW' | 'NOTICE_DEFERRED' | 'OPEN' | 'CLOSED' {
  if (row.blockedAt) return 'BLOCKED';
  if (row.ownerReviewDueAt && !row.reviewedAt) return 'URGENCY_PENDING_REVIEW';
  if (row.notificationDeferredAt && !row.notificationReleasedAt) return 'NOTICE_DEFERRED';
  if (!row.closedAt && !row.migratedFromAuditLogId && row.expiresAt > now) return 'OPEN';
  return 'CLOSED';
}

/**
 * H4 (registro y lectura del OWNER), CA3.2 (accesos de otras personas para el titular) y el
 * aviso diferido (CA3.4). Ningún listado devuelve el texto de la explicación.
 */
@Injectable()
export class ExceptionalAccessRegisterService {
  private readonly access: ClinicalAccessService;

  constructor(private readonly prisma: PrismaService, @Optional() access?: ClinicalAccessService) {
    this.access = access ?? new ClinicalAccessService(prisma);
  }

  /** CA4.1: OWNER todo el workspace; ADMIN solo los suyos; THERAPIST/ASSISTANT 403. */
  async list(workspaceId: string, actor: AuthUser) {
    const role = await this.adminRole(workspaceId, actor, 'exceptional-access-register');
    const ownOnly = role === 'ADMIN';
    const [accesses, openings] = await Promise.all([
      this.prisma.exceptionalAccessJustification.findMany({
        where: { workspaceId, ...(ownOnly ? { actorId: actor.sub } : {}) }, orderBy: { createdAt: 'desc' }, take: 500, select: ACCESS_LIST_SELECT,
      }),
      // Aperturas sobre historia ajena (H6). El OWNER las ve todas; el ADMIN, las suyas.
      this.prisma.clinicalProcessOpening.findMany({
        where: { workspaceId, ...(ownOnly ? { actorId: actor.sub } : {}) }, orderBy: { createdAt: 'desc' }, take: 500, select: OPENING_LIST_SELECT,
      }),
    ]);
    const patientIds = [...new Set([...accesses, ...openings].map((row) => row.patientId))];
    const initials = await this.patientInitialsById(workspaceId, patientIds);
    const now = new Date();
    return {
      accesses: accesses.map((row) => ({ type: 'EXCEPTIONAL_ACCESS' as const, ...row, patientInitials: initials.get(row.patientId) ?? null, status: accessStatus(row, now) })),
      openings: openings.map((row) => ({ type: 'PROCESS_OPENING_OVER_HISTORY' as const, ...row, patientInitials: initials.get(row.patientId) ?? null, pendingReview: Boolean(row.ownerReviewDueAt && !row.reviewedAt) })),
    };
  }

  /** CA4.2 / CA4.6: solo OWNER, con motivo de lectura auditado; paciente bloqueado → motivos de bloqueo. */
  async readJustification(workspaceId: string, actor: AuthUser, accessId: string, purpose: JustificationReadPurposeValue) {
    await this.ownerOnly(workspaceId, actor, 'exceptional-access-justification');
    const row = await this.prisma.exceptionalAccessJustification.findFirst({ where: { id: accessId, workspaceId }, select: { id: true, patientId: true, justification: true, blockedAt: true } });
    if (!row) throw new NotFoundException('Acceso no encontrado');
    if (row.blockedAt && !BLOCKED_READ_PURPOSES.includes(purpose)) {
      throw new ForbiddenException('Paciente bloqueado: la explicación solo se lee por reclamación, autoridad o derechos del interesado');
    }
    await this.prisma.auditLog.create({
      data: { workspaceId, actorId: actor.sub, action: 'EXCEPTIONAL_ACCESS_JUSTIFICATION_READ', entityType: 'ExceptionalAccessJustification', entityId: row.id, metadata: { purpose, blocked: Boolean(row.blockedAt) } },
    });
    return { id: row.id, justification: decryptField(row.justification) ?? null };
  }

  /** CA4.3–CA4.5 con las decisiones del Jefe del 15/10 (reviewPermission). */
  async reviewAccess(workspaceId: string, actor: AuthUser, accessId: string, outcome: 'CORRECT' | 'INCIDENT') {
    await this.ownerOnly(workspaceId, actor, 'exceptional-access-review');
    const row = await this.prisma.exceptionalAccessJustification.findFirst({ where: { id: accessId, workspaceId }, select: { id: true, actorId: true, ownerCountAtCreation: true, ownerReviewDueAt: true, reviewedAt: true } });
    if (!row) throw new NotFoundException('Acceso no encontrado');
    return this.applyReview(workspaceId, actor, row, outcome, 'exceptionalAccessJustification', 'EXCEPTIONAL_ACCESS_REVIEWED', 'ExceptionalAccessJustification');
  }

  async reviewOpening(workspaceId: string, actor: AuthUser, openingId: string, outcome: 'CORRECT' | 'INCIDENT') {
    await this.ownerOnly(workspaceId, actor, 'process-opening-review');
    const row = await this.prisma.clinicalProcessOpening.findFirst({ where: { id: openingId, workspaceId }, select: { id: true, actorId: true, ownerCountAtCreation: true, ownerReviewDueAt: true, reviewedAt: true } });
    if (!row) throw new NotFoundException('Apertura no encontrada');
    return this.applyReview(workspaceId, actor, row, outcome, 'clinicalProcessOpening', 'CLINICAL_PROCESS_OPENING_REVIEWED', 'ClinicalProcessOpening');
  }

  /** CA3.4: el OWNER libera un aviso diferido; el titular lo recibe entonces. */
  async releaseNotice(workspaceId: string, actor: AuthUser, accessId: string) {
    await this.ownerOnly(workspaceId, actor, 'exceptional-access-release');
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const row = await tx.exceptionalAccessJustification.findFirst({
        where: { id: accessId, workspaceId, notificationDeferredAt: { not: null }, notificationReleasedAt: null },
        select: { id: true, patientId: true, actorId: true, actorRole: true, reasonCode: true },
      });
      if (!row) throw new NotFoundException('No hay ningún aviso diferido pendiente para este acceso');
      const { count } = await tx.exceptionalAccessJustification.updateMany({ where: { id: row.id, workspaceId, notificationReleasedAt: null }, data: { notificationReleasedAt: now } });
      if (count === 0) throw new NotFoundException('No hay ningún aviso diferido pendiente para este acceso');
      const patient = await tx.patient.findFirst({ where: { id: row.patientId, workspaceId }, select: { id: true, firstName: true, lastName: true } });
      const sent = await notifyAuthors(tx, { workspaceId, actorId: row.actorId, actorRole: row.actorRole, patient: patient ?? { id: row.patientId }, reasonCode: row.reasonCode as ExceptionalAccessReasonCode, accessId: row.id, now });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'EXCEPTIONAL_ACCESS_NOTICE_RELEASED', entityType: 'ExceptionalAccessJustification', entityId: row.id, metadata: { notices: sent } } });
      return { released: true };
    });
  }

  /**
   * CA3.2: "Accesos de otras personas" en la ficha, para quien es autor de algún proceso del
   * paciente. Accesos (no diferidos o ya liberados) y aperturas sobre su historia. Nunca el texto.
   */
  async patientAccessHistory(workspaceId: string, actor: AuthUser, patientId: string) {
    assertStaffRole(actor);
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId }, select: { id: true } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    const authored = await this.prisma.clinicalProcess.findFirst({ where: { workspaceId, patientId, therapistId: actor.sub }, select: { id: true } });
    if (!authored || !(await this.access.isClinician(workspaceId, actor))) {
      await this.access.auditDenied(workspaceId, actor, 'patient-access-history', 'NO_PROCESS', patientId);
      throw new ForbiddenException('Solo los profesionales de este paciente ven sus accesos');
    }
    const [accesses, openings] = await Promise.all([
      this.prisma.exceptionalAccessJustification.findMany({
        where: { workspaceId, patientId, actorId: { not: actor.sub }, migratedFromAuditLogId: null, OR: [{ notificationDeferredAt: null }, { notificationReleasedAt: { not: null } }] },
        orderBy: { createdAt: 'desc' },
        select: { id: true, actorId: true, actorRole: true, reasonCode: true, createdAt: true, expiresAt: true, closedAt: true },
      }),
      this.prisma.clinicalProcessOpening.findMany({
        where: { workspaceId, patientId, actorId: { not: actor.sub } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, actorId: true, actorRole: true, reasonCode: true, kind: true, targetTherapistId: true, createdAt: true },
      }),
    ]);
    const names = await this.userNames(workspaceId, [...accesses, ...openings].map((row) => row.actorId));
    return {
      accesses: accesses.map((row) => ({ ...row, actorName: names.get(row.actorId) ?? null, endedAt: row.closedAt && row.closedAt < row.expiresAt ? row.closedAt : row.expiresAt })),
      openings: openings.map((row) => ({ ...row, actorName: names.get(row.actorId) ?? null })),
    };
  }

  // ---------------------------------------------------------------------------------------

  private async applyReview(
    workspaceId: string,
    actor: AuthUser,
    row: { id: string; actorId: string; ownerCountAtCreation: number; ownerReviewDueAt: Date | null; reviewedAt: Date | null },
    outcome: 'CORRECT' | 'INCIDENT',
    model: 'exceptionalAccessJustification' | 'clinicalProcessOpening',
    action: string,
    entityType: string,
  ) {
    if (outcome !== 'CORRECT' && outcome !== 'INCIDENT') throw new BadRequestException('Resultado no válido');
    if (!row.ownerReviewDueAt) throw new BadRequestException('Este registro no requiere revisión');
    if (row.reviewedAt) throw new BadRequestException('Ya está revisado');
    const owners = await this.prisma.workspaceMember.findMany({ where: { workspaceId, role: 'OWNER' }, select: { userId: true } });
    const permission = reviewPermission(row, actor.sub, owners.map((owner) => owner.userId));
    if (!permission.allowed) {
      await this.access.auditDenied(workspaceId, actor, `${entityType}-review`, 'ROLE');
      throw new ForbiddenException('Lo revisa otro titular de la consulta');
    }
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const delegate = tx[model] as unknown as { updateMany: (args: unknown) => Promise<{ count: number }> };
      const { count } = await delegate.updateMany({
        where: { id: row.id, workspaceId, reviewedAt: null },
        data: { reviewedAt: now, reviewedById: actor.sub, reviewOutcome: outcome, selfReview: permission.selfReview },
      });
      if (count === 0) throw new BadRequestException('Ya está revisado');
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action, entityType, entityId: row.id, metadata: { outcome, selfReview: permission.selfReview, lastOwnerStanding: permission.lastOwnerStanding } },
      });
      return { reviewed: true, selfReview: permission.selfReview, lastOwnerStanding: permission.lastOwnerStanding };
    });
  }

  private async adminRole(workspaceId: string, actor: AuthUser, resource: string): Promise<'OWNER' | 'ADMIN'> {
    assertStaffRole(actor);
    const profile = await this.access.getMemberProfile(workspaceId, actor);
    if (profile?.role !== 'OWNER' && profile?.role !== 'ADMIN') {
      await this.access.auditDenied(workspaceId, actor, resource, profile ? 'ROLE' : 'NOT_MEMBER');
      throw new ForbiddenException('No tienes acceso al registro de accesos excepcionales');
    }
    return profile.role;
  }

  private async ownerOnly(workspaceId: string, actor: AuthUser, resource: string) {
    if ((await this.adminRole(workspaceId, actor, resource)) !== 'OWNER') {
      await this.access.auditDenied(workspaceId, actor, resource, 'ROLE');
      throw new ForbiddenException('Solo el titular de la consulta');
    }
  }

  private async patientInitialsById(workspaceId: string, ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const rows = await this.prisma.patient.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
    return new Map(rows.map((row) => [row.id, `${row.firstName.charAt(0)}${row.lastName.charAt(0)}`.toUpperCase()]));
  }

  private async userNames(workspaceId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const rows = await this.prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: unique } }, select: { userId: true, user: { select: { firstName: true, lastName: true } } } });
    return new Map(rows.map((row) => [row.userId, `${row.user.firstName} ${row.user.lastName}`.trim()]));
  }
}

/**
 * Recordatorio cada 30 días al OWNER mientras haya avisos diferidos sin liberar (§3.6). Lo
 * ejecuta el lote de notificaciones (NotificationsService.processDue).
 */
export async function sendDeferredNoticeReminders(prisma: PrismaService, workspaceId: string, now = new Date()) {
  const due = await prisma.exceptionalAccessJustification.findMany({
    where: { workspaceId, notificationDeferredAt: { not: null }, notificationReleasedAt: null, lastDeferralReminderAt: { lte: new Date(now.getTime() - DEFERRED_NOTICE_REMINDER_MS) } },
    select: { id: true },
  });
  if (!due.length) return 0;
  const owners = await prisma.workspaceMember.findMany({ where: { workspaceId, role: 'OWNER' }, select: { userId: true } });
  const stamp = now.toISOString().slice(0, 10);
  await prisma.notification.createMany({
    data: due.flatMap((row) => owners.map((owner) => ({
      workspaceId, audience: 'PROFESSIONAL' as const, userId: owner.userId, type: 'CLINICAL_ACCESS_NOTICE' as const,
      title: 'Aviso diferido pendiente', body: 'Hay un acceso excepcional con el aviso al terapeuta diferido. Revísalo y libéralo cuando sea posible.',
      actionUrl: '/settings/exceptional-access', status: 'SENT' as const, scheduledAt: now, sentAt: now,
      dedupeKey: `exceptional-access-deferred:${row.id}:${owner.userId}:${stamp}`,
    }))),
    skipDuplicates: true,
  });
  await prisma.exceptionalAccessJustification.updateMany({ where: { workspaceId, id: { in: due.map((row) => row.id) } }, data: { lastDeferralReminderAt: now } });
  return due.length;
}

