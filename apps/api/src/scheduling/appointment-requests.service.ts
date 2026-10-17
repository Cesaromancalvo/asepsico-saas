import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { ListAppointmentRequestsQueryDto, RejectAppointmentRequestDto } from './dto/scheduling.dto';
import { expireDueRequests, notifyPatientOfRequestUpdates } from './appointment-request-lifecycle.util';
import { findScheduleConflict, lockTherapistSchedule } from './schedule-lock.util';
import { bookingConflict, slotNotAvailable } from './booking-config.util';

/**
 * Vista administrativa de las solicitudes: fecha, hora, paciente (nombre), profesional y tipo.
 * NUNCA motivo de consulta, proceso (más allá del id), objetivos ni notas.
 */
const STAFF_REQUEST_SELECT = {
  id: true, type: true, status: true, startsAt: true, endsAt: true, sessionId: true, accessorType: true,
  rejectionReason: true, expiresAt: true, createdAt: true, resolvedAt: true,
  patient: { select: { id: true, firstName: true, lastName: true } },
  therapist: { select: { id: true, firstName: true, lastName: true } },
} as const;

type RequestRow = {
  id: string; workspaceId: string; patientId: string; therapistId: string; clinicalProcessId: string | null;
  sessionId: string | null; type: 'NEW' | 'RESCHEDULE' | 'CANCEL'; startsAt: Date | null; endsAt: Date | null;
};

/**
 * Bandeja de solicitudes de cita del portal.
 *  - THERAPIST: ve y resuelve solo las suyas.
 *  - OWNER / ADMIN / ASSISTANT: ven y resuelven las de todo el espacio (es organización de agenda).
 */
@Injectable()
export class AppointmentRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthUser, query: ListAppointmentRequestsQueryDto) {
    assertStaffRole(actor);
    const workspaceId = actor.workspaceId;
    await this.prisma.$transaction((tx) => expireDueRequests(tx, workspaceId, this.scope(actor)));
    const rows = await this.prisma.appointmentRequest.findMany({
      where: {
        workspaceId,
        ...(query.status ? { status: query.status } : {}),
        ...(actor.role === 'THERAPIST' ? { therapistId: actor.sub } : query.therapistId ? { therapistId: query.therapistId } : {}),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      select: STAFF_REQUEST_SELECT,
    });
    // Para cambio y cancelación, la hora actual de la cita afectada (solo inicio y fin).
    const sessionIds = rows.map((r) => r.sessionId).filter((id): id is string => Boolean(id));
    const sessions = sessionIds.length
      ? await this.prisma.session.findMany({ where: { workspaceId, id: { in: sessionIds } }, select: { id: true, startsAt: true, endsAt: true, status: true } })
      : [];
    return rows.map((row) => ({ ...row, session: sessions.find((s) => s.id === row.sessionId) ?? null }));
  }

  async pendingCount(actor: AuthUser) {
    assertStaffRole(actor);
    const workspaceId = actor.workspaceId;
    await this.prisma.$transaction((tx) => expireDueRequests(tx, workspaceId, this.scope(actor)));
    const pending = await this.prisma.appointmentRequest.count({ where: { workspaceId, status: 'PENDING', ...this.scope(actor) } });
    return { pending };
  }

  /**
   * Aprobar, en una sola transacción y con la agenda del profesional bloqueada:
   *  - NEW: crea la Session SCHEDULED en el proceso activo.
   *  - RESCHEDULE: mueve la cita original (que seguía en pie) al hueco nuevo.
   *  - CANCEL: cancela la cita.
   * Si el proceso ya no está activo, el paciente ya no está ACTIVE o el hueco ya no está libre → 409
   * y no se escribe nada.
   */
  async approve(actor: AuthUser, id: string) {
    assertStaffRole(actor);
    const workspaceId = actor.workspaceId;
    const request = await this.findForActor(actor, id);

    await this.prisma.$transaction(async (tx) => {
      await lockTherapistSchedule(tx, workspaceId, request.therapistId);
      await expireDueRequests(tx, workspaceId, { therapistId: request.therapistId });
      const current = await tx.appointmentRequest.findFirst({ where: { id, workspaceId, status: 'PENDING' }, select: { id: true } });
      if (!current) throw bookingConflict('REQUEST_NOT_PENDING', 'La solicitud ya no está pendiente.');

      const patient = await tx.patient.findFirst({ where: { id: request.patientId, workspaceId, deletedAt: null, status: 'ACTIVE' }, select: { id: true } });
      if (!patient) throw bookingConflict('PATIENT_NOT_ACTIVE', 'El paciente ya no está activo.');
      await this.lockActiveProcess(tx, request);

      let sessionId = request.sessionId;
      if (request.type === 'NEW') {
        sessionId = await this.createSession(tx, actor, request);
      } else if (request.type === 'RESCHEDULE') {
        await this.moveSession(tx, actor, request);
      } else {
        await this.cancelSession(tx, actor, request);
      }

      const { count } = await tx.appointmentRequest.updateMany({
        where: { id, workspaceId, status: 'PENDING' },
        data: { status: 'APPROVED', heldStartsAt: null, sessionId, resolvedAt: new Date(), resolvedById: actor.sub },
      });
      if (!count) throw bookingConflict('REQUEST_NOT_PENDING', 'La solicitud ya no está pendiente.');
      await tx.auditLog.create({
        data: {
          workspaceId, actorId: actor.sub, action: 'APPOINTMENT_REQUEST_APPROVED', entityType: 'AppointmentRequest', entityId: id,
          metadata: { patientId: request.patientId, therapistId: request.therapistId, type: request.type, sessionId, startsAt: request.startsAt?.toISOString() ?? null },
        },
      });
      await notifyPatientOfRequestUpdates(tx, workspaceId, [{ id, patientId: request.patientId }], 'APPROVED');
    });
    return this.getView(workspaceId, id);
  }

  /** Rechazar con un motivo de lista cerrada (visible para el paciente). El hueco se libera. */
  async reject(actor: AuthUser, id: string, dto: RejectAppointmentRequestDto) {
    assertStaffRole(actor);
    const workspaceId = actor.workspaceId;
    const request = await this.findForActor(actor, id);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.appointmentRequest.updateMany({
        where: { id, workspaceId, status: 'PENDING' },
        data: { status: 'REJECTED', rejectionReason: dto.reason, heldStartsAt: null, resolvedAt: new Date(), resolvedById: actor.sub },
      });
      if (!count) throw bookingConflict('REQUEST_NOT_PENDING', 'La solicitud ya no está pendiente.');
      await tx.auditLog.create({
        data: {
          workspaceId, actorId: actor.sub, action: 'APPOINTMENT_REQUEST_REJECTED', entityType: 'AppointmentRequest', entityId: id,
          metadata: { patientId: request.patientId, therapistId: request.therapistId, type: request.type, reason: dto.reason },
        },
      });
      await notifyPatientOfRequestUpdates(tx, workspaceId, [{ id, patientId: request.patientId }], 'REJECTED');
    });
    return this.getView(workspaceId, id);
  }

  // ---------------------------------------------------------------------------------------------

  private scope(actor: AuthUser) {
    return actor.role === 'THERAPIST' ? { therapistId: actor.sub } : {};
  }

  /** Solicitud del espacio; un THERAPIST solo las suyas (403 auditado si es de otro). */
  private async findForActor(actor: AuthUser, id: string): Promise<RequestRow> {
    const request = await this.prisma.appointmentRequest.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      select: { id: true, workspaceId: true, patientId: true, therapistId: true, clinicalProcessId: true, sessionId: true, type: true, startsAt: true, endsAt: true },
    });
    if (!request) throw new NotFoundException('Solicitud no encontrada');
    if (actor.role === 'THERAPIST' && request.therapistId !== actor.sub) {
      await this.prisma.auditLog.create({
        data: { workspaceId: actor.workspaceId, actorId: actor.sub, action: 'APPOINTMENT_REQUEST_ACCESS_DENIED', entityType: 'AppointmentRequest', entityId: id, metadata: { therapistId: request.therapistId } },
      });
      throw new ForbiddenException('No puedes resolver solicitudes de otro profesional');
    }
    return request;
  }

  private async lockActiveProcess(tx: Prisma.TransactionClient, request: RequestRow) {
    const { count } = request.clinicalProcessId
      ? await tx.clinicalProcess.updateMany({
          where: { id: request.clinicalProcessId, workspaceId: request.workspaceId, patientId: request.patientId, therapistId: request.therapistId, status: 'ACTIVE' },
          data: { updatedAt: new Date() },
        })
      : { count: 0 };
    if (!count) throw bookingConflict('PROCESS_NOT_ACTIVE', 'El proceso clínico ya no está activo.');
  }

  private async createSession(tx: Prisma.TransactionClient, actor: AuthUser, request: RequestRow): Promise<string> {
    const { workspaceId } = request;
    const startsAt = request.startsAt as Date;
    const endsAt = request.endsAt as Date;
    const conflict = await findScheduleConflict(tx, { workspaceId, therapistId: request.therapistId, startsAt, endsAt, excludeRequestId: request.id, includeBlocks: true });
    if (conflict) throw slotNotAvailable();
    const session = await tx.session.create({
      data: { workspaceId, patientId: request.patientId, therapistId: request.therapistId, clinicalProcessId: request.clinicalProcessId, startsAt, endsAt, type: 'INDIVIDUAL', status: 'SCHEDULED' },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        workspaceId, actorId: actor.sub, action: 'SESSION_CREATED', entityType: 'Session', entityId: session.id,
        metadata: { patientId: request.patientId, therapistId: request.therapistId, clinicalProcessId: request.clinicalProcessId, type: 'INDIVIDUAL', source: 'PORTAL_REQUEST', appointmentRequestId: request.id },
      },
    });
    return session.id;
  }

  private async moveSession(tx: Prisma.TransactionClient, actor: AuthUser, request: RequestRow) {
    const { workspaceId } = request;
    const startsAt = request.startsAt as Date;
    const endsAt = request.endsAt as Date;
    const original = await tx.session.findFirst({
      where: { id: request.sessionId ?? '', workspaceId, patientId: request.patientId, therapistId: request.therapistId, status: 'SCHEDULED' },
      select: { id: true, startsAt: true, endsAt: true },
    });
    if (!original) throw bookingConflict('SESSION_NOT_SCHEDULED', 'La cita original ya no está programada.');
    const conflict = await findScheduleConflict(tx, { workspaceId, therapistId: request.therapistId, startsAt, endsAt, excludeSessionId: original.id, excludeRequestId: request.id, includeBlocks: true });
    if (conflict) throw slotNotAvailable();
    const { count } = await tx.session.updateMany({ where: { id: original.id, workspaceId, status: 'SCHEDULED' }, data: { startsAt, endsAt } });
    if (!count) throw bookingConflict('SESSION_NOT_SCHEDULED', 'La cita original ya no está programada.');
    await tx.auditLog.create({
      data: {
        workspaceId, actorId: actor.sub, action: 'SESSION_RESCHEDULED', entityType: 'Session', entityId: original.id,
        metadata: { from: { startsAt: original.startsAt, endsAt: original.endsAt }, to: { startsAt, endsAt }, source: 'PORTAL_REQUEST', appointmentRequestId: request.id },
      },
    });
  }

  private async cancelSession(tx: Prisma.TransactionClient, actor: AuthUser, request: RequestRow) {
    const { workspaceId } = request;
    const { count } = await tx.session.updateMany({
      where: { id: request.sessionId ?? '', workspaceId, patientId: request.patientId, status: 'SCHEDULED' },
      data: { status: 'CANCELLED' },
    });
    if (!count) throw bookingConflict('SESSION_NOT_SCHEDULED', 'La cita ya no está programada.');
    await tx.auditLog.create({
      data: {
        workspaceId, actorId: actor.sub, action: 'SESSION_STATUS_CHANGED', entityType: 'Session', entityId: request.sessionId,
        metadata: { from: 'SCHEDULED', to: 'CANCELLED', source: 'PORTAL_REQUEST', appointmentRequestId: request.id },
      },
    });
  }

  private async getView(workspaceId: string, id: string) {
    const row = await this.prisma.appointmentRequest.findFirst({ where: { id, workspaceId }, select: STAFF_REQUEST_SELECT });
    if (!row) throw new NotFoundException('Solicitud no encontrada');
    return row;
  }
}
