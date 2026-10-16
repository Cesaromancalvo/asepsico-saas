import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { encryptField } from '../common/crypto/field-encryption';
import { ClinicalAccessService } from '../clinical-access/clinical-access.service';
import { currentAuthorsOfPatient, sendClinicalAccessNotices } from './clinical-access-notice';
import {
  DEFERRABLE_NOTICE_REASONS,
  EXCEPTIONAL_ACCESS_REASON_LABELS,
  EXCEPTIONAL_ACCESS_WINDOW_MS,
  ExceptionalAccessReasonCode,
  OWNER_REVIEW_REASONS,
  OWNER_REVIEW_WINDOW_MS,
  containsClinicalTerms,
  exceptionalReasonsFor,
  isExceptionalAccessReason,
  retentionUntil,
} from './exceptional-access.policy';
import { CreateExceptionalAccessDto } from './dto/exceptional-access.dto';

/** 400 cuando la explicación parece clínica y el usuario aún no ha confirmado (CA1.7). */
export const CLINICAL_TERMS_WARNING = 'CLINICAL_TERMS_WARNING';
/** 409 si ya tiene acceso clínico por E1 o un acceso excepcional vigente (CA1.2). */
export const EXCEPTIONAL_ACCESS_NOT_NEEDED = 'EXCEPTIONAL_ACCESS_NOT_NEEDED';
/** 401 si el token no lleva sesión (`sid`, tokens anteriores): hay que refrescar sesión. */
export const SESSION_REQUIRED = 'SESSION_REQUIRED';

type NoticeTx = Prisma.TransactionClient;

/**
 * H1–H3: registrar el acceso excepcional (que concede EXCEPTIONAL durante 8 h a esta sesión),
 * cerrarlo, consultarlo y avisar al titular. La concesión la decide SIEMPRE ClinicalAccessService
 * en cada petición; este servicio solo crea y cierra registros.
 */
@Injectable()
export class ExceptionalAccessService {
  private readonly access: ClinicalAccessService;

  constructor(private readonly prisma: PrismaService, @Optional() access?: ClinicalAccessService) {
    this.access = access ?? new ClinicalAccessService(prisma);
  }

  async create(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateExceptionalAccessDto) {
    assertStaffRole(actor);
    // CA1.3: THERAPIST y ASSISTANT nunca (por el rol de la BD, no el del token).
    const profile = await this.access.getMemberProfile(workspaceId, actor);
    const allowedReasons = profile ? exceptionalReasonsFor(profile) : [];
    if (!profile || !allowedReasons.length) {
      await this.access.auditDenied(workspaceId, actor, 'exceptional-access', profile ? 'ROLE' : 'NOT_MEMBER', patientId);
      throw new ForbiddenException('Solo la dirección de la consulta puede registrar un acceso excepcional');
    }
    // CA1.10: otro workspace o borrado → 404.
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, workspaceId, deletedAt: null, blockedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');

    // CA1.5 (también sin ValidationPipe) y CA1.6 (sin perfil clínico, solo administrativos).
    if (!isExceptionalAccessReason(dto.reasonCode)) throw new BadRequestException('Motivo no válido');
    if (!allowedReasons.includes(dto.reasonCode)) {
      await this.access.auditDenied(workspaceId, actor, 'exceptional-access-reason', 'NOT_CLINICIAN', patientId);
      throw new ForbiddenException('Ese motivo solo lo puede usar un profesional clínico');
    }
    const justification = typeof dto.justification === 'string' ? dto.justification.trim() : '';
    if (dto.confirmed !== true || justification.length < 20 || justification.length > 300) {
      throw new BadRequestException('Completa el motivo, la explicación (20–300 caracteres) y la confirmación');
    }

    // Aviso diferido (§3.6, CA3.4): solo OWNER y solo en tres códigos; con motivo.
    const deferNotice = dto.deferNotice === true;
    if (deferNotice) {
      if (profile.role !== 'OWNER') throw new ForbiddenException('Solo el titular de la consulta puede diferir el aviso');
      if (!DEFERRABLE_NOTICE_REASONS.includes(dto.reasonCode)) throw new BadRequestException('Este motivo no permite diferir el aviso');
      if (typeof dto.deferReason !== 'string' || dto.deferReason.trim().length < 20) throw new BadRequestException('Indica el motivo para diferir el aviso');
    }

    // CA1.2: si ya tiene acceso por E1 (TREATING) o un acceso excepcional vigente, no se crea nada.
    const scope = await this.access.resolveScope(workspaceId, actor, patientId);
    if (scope?.level === 'TREATING' || scope?.level === 'EXCEPTIONAL') {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', code: EXCEPTIONAL_ACCESS_NOT_NEEDED, message: scope.level === 'TREATING' ? 'Ya atiendes a este paciente' : 'Ya tienes un acceso excepcional vigente a este paciente' });
    }
    // C3: el acceso se liga a la sesión de autenticación de esta petición.
    if (typeof actor.sid !== 'string' || !actor.sid) {
      throw new UnauthorizedException({ statusCode: 401, code: SESSION_REQUIRED, message: 'Vuelve a iniciar sesión para registrar el acceso' });
    }

    // CA1.7: avisa, no bloquea. Sin confirmación → 400 reconocible; con ella → se marca.
    const clinicalTerms = containsClinicalTerms(justification);
    if (clinicalTerms && dto.clinicalTermWarningAcknowledged !== true) {
      throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: CLINICAL_TERMS_WARNING, message: 'Parece que has incluido información clínica. Explica solo el motivo administrativo.' });
    }

    const reasonCode = dto.reasonCode;
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const ownerCountAtCreation = await tx.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
      const record = await tx.exceptionalAccessJustification.create({
        data: {
          workspaceId,
          patientId,
          actorId: actor.sub,
          actorRole: profile.role as 'OWNER' | 'ADMIN',
          actorIsClinician: profile.isClinician,
          reasonCode,
          justification: encryptField(justification)!,
          clinicalTermWarningIgnored: clinicalTerms,
          authSessionId: actor.sid!,
          createdAt: now,
          expiresAt: new Date(now.getTime() + EXCEPTIONAL_ACCESS_WINDOW_MS),
          retentionUntil: retentionUntil(now),
          ownerCountAtCreation,
          ownerReviewDueAt: OWNER_REVIEW_REASONS.includes(reasonCode) ? new Date(now.getTime() + OWNER_REVIEW_WINDOW_MS) : null,
          ...(deferNotice ? { notificationDeferredAt: now, notificationDeferredReason: encryptField(dto.deferReason!.trim()), lastDeferralReminderAt: now } : {}),
        },
        select: { id: true, reasonCode: true, createdAt: true, expiresAt: true, ownerReviewDueAt: true, notificationDeferredAt: true },
      });
      // CA1.8: metadata SOLO { reasonCode, role, exceptionalAccessId }. Nunca el texto.
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: 'EXCEPTIONAL_CLINICAL_ACCESS', entityType: 'Patient', entityId: patientId, metadata: { reasonCode, role: profile.role, exceptionalAccessId: record.id } },
      });
      if (deferNotice) {
        await tx.auditLog.create({
          data: { workspaceId, actorId: actor.sub, action: 'EXCEPTIONAL_ACCESS_NOTICE_DEFERRED', entityType: 'ExceptionalAccessJustification', entityId: record.id, metadata: { reasonCode } },
        });
      } else {
        await notifyAuthors(tx, { workspaceId, actorId: actor.sub, actorRole: profile.role, patient, reasonCode, accessId: record.id, now });
      }
      return { ...record, hoursValid: EXCEPTIONAL_ACCESS_WINDOW_MS / 3_600_000, noticeDeferred: deferNotice };
    });
  }

  /** [Cerrar acceso]: solo el propio acceso, del workspace, si sigue abierto. */
  async close(workspaceId: string, actor: AuthUser, patientId: string, accessId: string) {
    assertStaffRole(actor);
    const now = new Date();
    const { count } = await this.prisma.exceptionalAccessJustification.updateMany({
      where: { id: accessId, workspaceId, patientId, actorId: actor.sub, closedAt: null },
      data: { closedAt: now, closeReason: 'MANUAL' },
    });
    if (count === 0) throw new NotFoundException('Acceso no encontrado o ya cerrado');
    await this.prisma.auditLog.create({
      data: { workspaceId, actorId: actor.sub, action: 'EXCEPTIONAL_ACCESS_CLOSED', entityType: 'ExceptionalAccessJustification', entityId: accessId, metadata: { closeReason: 'MANUAL' } },
    });
    return { closed: true };
  }

  /**
   * Acceso vigente del actor con este paciente EN ESTA SESIÓN (para la banda de la ficha). Lo
   * decide ClinicalAccessService, así que coincide con lo que la API concede. Sin texto.
   */
  async current(workspaceId: string, actor: AuthUser, patientId: string) {
    assertStaffRole(actor);
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId }, select: { id: true } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    const profile = await this.access.getMemberProfile(workspaceId, actor);
    const scope = await this.access.resolveScope(workspaceId, actor, patientId);
    const allowedReasons = profile ? exceptionalReasonsFor(profile) : [];
    if (scope?.level !== 'EXCEPTIONAL' || !scope.exceptionalAccessId) {
      return { active: null, canRequest: allowedReasons.length > 0 && scope?.level !== 'TREATING', allowedReasons };
    }
    const row = await this.prisma.exceptionalAccessJustification.findFirst({
      where: { id: scope.exceptionalAccessId, workspaceId, actorId: actor.sub },
      select: { id: true, reasonCode: true, createdAt: true, expiresAt: true },
    });
    return { active: row, canRequest: false, allowedReasons };
  }

  /** CA1.11: "Mi motivo no está en la lista". Solo un contador por workspace. */
  async countReasonMiss(workspaceId: string, actor: AuthUser) {
    assertStaffRole(actor);
    const profile = await this.access.getMemberProfile(workspaceId, actor);
    if (!profile || !exceptionalReasonsFor(profile).length) throw new ForbiddenException();
    await this.prisma.exceptionalAccessReasonMiss.upsert({
      where: { workspaceId },
      create: { workspaceId, count: 1 },
      update: { count: { increment: 1 } },
    });
    return { counted: true };
  }
}

/**
 * Aviso a los autores de procesos del paciente que siguen siendo miembros (CA3.1). Un titular
 * que ya no está en el workspace no recibe nada (CA3.3, incluido CUSTODY).
 */
export async function notifyAuthors(
  tx: NoticeTx,
  input: { workspaceId: string; actorId: string; actorRole: string; patient: { id: string; firstName?: string | null; lastName?: string | null }; reasonCode: ExceptionalAccessReasonCode; accessId: string; now: Date },
) {
  const recipients = await currentAuthorsOfPatient(tx, input.workspaceId, input.patient.id, [input.actorId]);
  return sendClinicalAccessNotices(tx, {
    workspaceId: input.workspaceId,
    recipientIds: recipients,
    actorId: input.actorId,
    actorRole: input.actorRole,
    patient: input.patient,
    action: 'abrió la historia de',
    reasonLabel: EXCEPTIONAL_ACCESS_REASON_LABELS[input.reasonCode],
    title: 'Acceso excepcional a la historia de tu paciente',
    eventKey: `exceptional-access:${input.accessId}`,
    now: input.now,
  });
}
