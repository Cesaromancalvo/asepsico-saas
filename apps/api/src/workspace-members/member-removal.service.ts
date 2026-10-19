import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { isClinicalProfile } from '../clinical-access/clinical-access.service';
import { PrismaService } from '../database/prisma.service';
import { rejectPendingRequestsOfTherapist } from '../scheduling/appointment-request-lifecycle.util';
import { findScheduleConflict, lockTherapistSchedule } from '../scheduling/schedule-lock.util';
import { ReassignMemberWorkDto, RemoveMemberDto } from './dto/remove-member.dto';

type Tx = Prisma.TransactionClient;

/** Procesos que siguen vivos y por tanto se reasignan. Los cerrados conservan su autor. */
const OPEN_PROCESS_STATUSES = ['ACTIVE', 'PAUSED'] as const;

export const MEMBER_REMOVED_ACTION = 'MEMBER_REMOVED';
export const MEMBER_WORK_REASSIGNED_ACTION = 'MEMBER_WORK_REASSIGNED';
export const PRIVATE_NOTES_ARCHIVED_ACTION = 'CLINICAL_PROCESS_PRIVATE_NOTES_ARCHIVED';

function conflict(code: string, message: string, extra: Record<string, unknown> = {}) {
  return new ConflictException({ statusCode: 409, code, message, ...extra });
}

/**
 * Baja de un miembro del equipo (historia B de docs/producto/mejoras-salida-y-confianza.md).
 *
 * - Solo OWNER/ADMIN según la BD. ADMIN solo da de baja a THERAPIST y ASSISTANT. Nadie se da de
 *   baja a sí mismo desde aquí, y nunca puede quedar un espacio sin OWNER activo.
 * - La membresía pasa a REMOVED (no se borra nada: autoría y auditoría intactas). El corte de
 *   acceso es inmediato: JwtAuthGuard rechaza en la siguiente petición cualquier access token de
 *   esa membresía y aquí se revocan sus refresh tokens y se cierran sus accesos excepcionales.
 * - Sus solicitudes de cita pendientes se rechazan ("contacta con la consulta") y se desactiva su
 *   reserva desde el portal.
 * - Con destino, sus procesos ACTIVE/PAUSED y sus citas futuras SCHEDULED pasan al destino en la
 *   misma transacción (con comprobación de solapes en la agenda del destino). Sin destino quedan
 *   pendientes y se reasignan después con reassignWork.
 * - Todo en una transacción, serializada por workspace con un advisory lock, filtrando siempre por
 *   workspaceId. La auditoría lleva solo recuentos e ids: nunca nombres de pacientes ni contenido.
 */
@Injectable()
export class MemberRemovalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lo que la web enseña antes de confirmar: recuentos y destinos posibles, sin contenido clínico. */
  async preview(workspaceId: string, actor: AuthUser, userId: string) {
    assertStaffRole(actor);
    const actorRole = await this.activeRole(this.prisma, workspaceId, actor.sub);
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { id: true, userId: true, role: true, isClinician: true, status: true },
    });
    if (!member) throw new NotFoundException('Miembro no encontrado');
    assertCanManage(actorRole, actor.sub, member);

    const [pending, candidates] = await Promise.all([
      this.pendingWork(this.prisma, workspaceId, userId, new Date()),
      this.prisma.workspaceMember.findMany({
        where: { workspaceId, status: 'ACTIVE', userId: { not: userId } },
        orderBy: { createdAt: 'asc' },
        select: { userId: true, role: true, isClinician: true, user: { select: { firstName: true, lastName: true } } },
      }),
    ]);
    return {
      userId: member.userId,
      role: member.role,
      status: member.status,
      ...pending,
      reassignTargets: candidates.filter(isClinicalProfile).map((c) => ({
        userId: c.userId,
        firstName: c.user?.firstName ?? null,
        lastName: c.user?.lastName ?? null,
      })),
    };
  }

  async remove(workspaceId: string, actor: AuthUser, userId: string, dto: RemoveMemberDto) {
    assertStaffRole(actor);
    if (userId === actor.sub) {
      throw new BadRequestException({ statusCode: 400, code: 'SELF_REMOVAL_NOT_ALLOWED', message: 'No puedes darte de baja a ti mismo desde el equipo' });
    }

    return this.prisma.$transaction(async (tx) => {
      await lockWorkspaceTeam(tx, workspaceId);
      // Rol del actor releído DENTRO del lock: otra baja concurrente pudo quitarle el acceso.
      const actorRole = await this.activeRole(tx, workspaceId, actor.sub);
      const member = await tx.workspaceMember.findFirst({
        where: { workspaceId, userId },
        select: { id: true, userId: true, role: true, isClinician: true, status: true },
      });
      if (!member) throw new NotFoundException('Miembro no encontrado');
      assertCanManage(actorRole, actor.sub, member);
      if (member.status !== 'ACTIVE') throw conflict('MEMBER_ALREADY_REMOVED', 'Este miembro ya está dado de baja');

      if (member.role === 'OWNER') {
        const owners = await tx.workspaceMember.count({ where: { workspaceId, role: 'OWNER', status: 'ACTIVE' } });
        if (owners <= 1) throw conflict('LAST_OWNER', 'No se puede dar de baja al único propietario del espacio');
      }
      if (dto.reassignToUserId && !isClinicalProfile(member)) {
        throw new BadRequestException({ statusCode: 400, code: 'NOTHING_TO_REASSIGN', message: 'Este miembro no tiene pacientes que reasignar' });
      }

      // Agenda del que se va (y del destino), en orden fijo, ANTES de escribir: una solicitud del
      // portal en curso o termina antes (y se rechaza abajo) o espera y ve la membresía REMOVED.
      const scheduleOwners = dto.reassignToUserId && dto.reassignToUserId !== userId ? [userId, dto.reassignToUserId] : [userId];
      for (const therapistId of scheduleOwners.sort()) await lockTherapistSchedule(tx, workspaceId, therapistId);

      const now = new Date();
      const { count } = await tx.workspaceMember.updateMany({
        where: { id: member.id, workspaceId, userId, status: 'ACTIVE' },
        data: { status: 'REMOVED', removedAt: now, removedById: actor.sub, removalReason: dto.reason ?? null },
      });
      if (count !== 1) throw conflict('MEMBER_CHANGED', 'El miembro cambió mientras se guardaba; vuelve a intentarlo');

      // Corte de acceso: sesiones (refresh) y accesos excepcionales de ESTE workspace.
      const revoked = await tx.refreshToken.updateMany({ where: { userId, workspaceId, revokedAt: null }, data: { revokedAt: now } });
      const closedAccesses = await tx.exceptionalAccessJustification.updateMany({
        where: { workspaceId, actorId: userId, closedAt: null },
        data: { closedAt: now, closeReason: 'MEMBER_REMOVED' },
      });
      const bookingDisabled = await tx.therapistAvailability.updateMany({
        where: { workspaceId, therapistId: userId, portalBookingEnabled: true },
        data: { portalBookingEnabled: false },
      });
      const rejectedRequests = await rejectPendingRequestsOfTherapist(tx, workspaceId, userId, actor.sub, 'MEMBER_REMOVED');

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: MEMBER_REMOVED_ACTION,
          entityType: 'WorkspaceMember',
          entityId: member.id,
          metadata: {
            userId, role: member.role, reason: dto.reason ?? null,
            revokedSessions: revoked.count, closedExceptionalAccesses: closedAccesses.count,
            portalBookingDisabled: bookingDisabled.count > 0, rejectedAppointmentRequests: rejectedRequests.length,
            reassignToUserId: dto.reassignToUserId ?? null,
          },
        },
      });

      const reassignment = dto.reassignToUserId
        ? await this.reassignInTx(tx, workspaceId, actor, member, dto.reassignToUserId, now)
        : null;
      const pending = await this.pendingWork(tx, workspaceId, userId, now);
      return {
        userId,
        status: 'REMOVED' as const,
        removedAt: now,
        revokedSessions: revoked.count,
        closedExceptionalAccesses: closedAccesses.count,
        rejectedAppointmentRequests: rejectedRequests.length,
        reassignment,
        pending,
      };
    });
  }

  /** "Decidir después": reasigna el trabajo pendiente de un miembro YA dado de baja. */
  async reassignWork(workspaceId: string, actor: AuthUser, userId: string, dto: ReassignMemberWorkDto) {
    assertStaffRole(actor);
    return this.prisma.$transaction(async (tx) => {
      await lockWorkspaceTeam(tx, workspaceId);
      const actorRole = await this.activeRole(tx, workspaceId, actor.sub);
      const member = await tx.workspaceMember.findFirst({
        where: { workspaceId, userId },
        select: { id: true, userId: true, role: true, isClinician: true, status: true },
      });
      if (!member) throw new NotFoundException('Miembro no encontrado');
      assertCanManage(actorRole, actor.sub, member);
      if (member.status !== 'REMOVED') {
        throw conflict('MEMBER_STILL_ACTIVE', 'Solo se reasigna aquí el trabajo de un miembro dado de baja');
      }
      const now = new Date();
      const reassignment = await this.reassignInTx(tx, workspaceId, actor, member, dto.toUserId, now);
      return { userId, reassignment, pending: await this.pendingWork(tx, workspaceId, userId, now) };
    });
  }

  /**
   * Mueve procesos ACTIVE/PAUSED y sus citas futuras SCHEDULED (o sin proceso, y sin resumen
   * interno) de `from` a `toUserId`. Exige un destino
   * clínico ACTIVE del mismo workspace y sin solapes en su agenda (409 con el número de choques).
   * Un único evento de auditoría con recuentos e ids (sin nombres ni contenido).
   */
  private async reassignInTx(
    tx: Tx,
    workspaceId: string,
    actor: AuthUser,
    from: { id: string; userId: string },
    toUserId: string,
    now: Date,
  ) {
    if (toUserId === from.userId) throw invalidTarget();
    const target = await tx.workspaceMember.findFirst({
      where: { workspaceId, userId: toUserId, status: 'ACTIVE' },
      select: { role: true, isClinician: true },
    });
    if (!target || !isClinicalProfile(target)) throw invalidTarget();

    // Mismo orden fijo en las dos agendas para no interbloquear con otra reasignación (en la baja ya
    // están tomados: los advisory locks de transacción son reentrantes).
    for (const therapistId of [from.userId, toUserId].sort()) await lockTherapistSchedule(tx, workspaceId, therapistId);

    const processesToMove = await tx.clinicalProcess.findMany({
      where: { workspaceId, therapistId: from.userId, status: { in: [...OPEN_PROCESS_STATUSES] } },
      orderBy: { id: 'asc' },
      select: { id: true, patientId: true, internalNotes: true },
    });
    // El destino no puede quedar con dos procesos abiertos con el mismo paciente: 409 y no se toca nada.
    const patientIds = [...new Set(processesToMove.map((p) => p.patientId))];
    const duplicated = patientIds.length
      ? await tx.clinicalProcess.count({
          where: { workspaceId, therapistId: toUserId, status: { in: [...OPEN_PROCESS_STATUSES] }, patientId: { in: patientIds } },
        })
      : 0;
    if (duplicated > 0) {
      throw conflict('REASSIGN_PROCESS_CONFLICT', 'El profesional elegido ya tiene un proceso abierto con alguno de estos pacientes', { conflicts: duplicated });
    }

    const processIds = processesToMove.map((p) => p.id);
    // Citas futuras que se mueven: solo las sin proceso o de un proceso que se reasigna ahora (las de
    // un proceso cerrado o ajeno conservan su profesional). Y nunca una con resumen interno: en
    // sessions.service el internalSummary solo lo lee el profesional de la cita (session.therapistId),
    // así que moverla se lo enseñaría al destino, y vaciarlo borraría una nota clínica de su autor.
    // Esas se quedan a nombre de quien se fue (pendientes, visibles en los recuentos) y se auditan.
    const movable = { workspaceId, therapistId: from.userId, status: 'SCHEDULED' as const, startsAt: { gte: now } };
    const [sessions, withPrivateNotes] = await Promise.all([
      tx.session.findMany({
        where: { ...movable, internalSummary: null, OR: [{ clinicalProcessId: null }, { clinicalProcessId: { in: processIds } }] },
        orderBy: { startsAt: 'asc' },
        select: { id: true, startsAt: true, endsAt: true },
      }),
      tx.session.findMany({
        where: { ...movable, internalSummary: { not: null }, OR: [{ clinicalProcessId: null }, { clinicalProcessId: { in: processIds } }] },
        orderBy: { startsAt: 'asc' },
        select: { id: true },
      }),
    ]);
    let conflicts = 0;
    for (const s of sessions) {
      const clash = await findScheduleConflict(tx, {
        workspaceId, therapistId: toUserId, startsAt: s.startsAt, endsAt: s.endsAt, includeBlocks: true, now,
      });
      if (clash) conflicts += 1;
    }
    if (conflicts > 0) {
      throw conflict('REASSIGN_SCHEDULE_CONFLICT', 'Algunas citas se solapan con la agenda del profesional elegido', { conflicts });
    }

    // Notas internas: tienen autor. Las del que se va se archivan (cifradas tal cual, sin descifrar)
    // con su autor y el campo vivo queda vacío para el destino, que nunca las lee ni las pisa.
    // Proceso a proceso con compare-and-set de las notas leídas: si cambiaron entretanto, 409.
    const archived: { processId: string; privateNoteId: string }[] = [];
    for (const p of processesToMove) {
      if (p.internalNotes) {
        const note = await tx.clinicalProcessPrivateNote.create({
          data: { workspaceId, processId: p.id, authorId: from.userId, notes: p.internalNotes, reason: 'REASSIGNED' },
          select: { id: true },
        });
        archived.push({ processId: p.id, privateNoteId: note.id });
      }
      const { count } = await tx.clinicalProcess.updateMany({
        where: { workspaceId, id: p.id, therapistId: from.userId, status: { in: [...OPEN_PROCESS_STATUSES] }, internalNotes: p.internalNotes ?? null },
        data: { therapistId: toUserId, internalNotes: null },
      });
      if (count !== 1) throw conflict('MEMBER_CHANGED', 'Los procesos cambiaron mientras se reasignaban; vuelve a intentarlo');
    }
    const processes = { count: processesToMove.length };
    if (archived.length) {
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: PRIVATE_NOTES_ARCHIVED_ACTION,
          entityType: 'ClinicalProcessPrivateNote',
          entityId: null,
          // Solo ids: nunca el contenido de las notas.
          metadata: { authorId: from.userId, toUserId, notes: archived },
        },
      });
    }
    const moved = sessions.length
      ? await tx.session.updateMany({
          where: { workspaceId, id: { in: sessions.map((s) => s.id) }, therapistId: from.userId, status: 'SCHEDULED', internalSummary: null },
          data: { therapistId: toUserId },
        })
      : { count: 0 };
    if (moved.count !== sessions.length) throw conflict('MEMBER_CHANGED', 'La agenda cambió mientras se reasignaba; vuelve a intentarlo');

    await tx.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action: MEMBER_WORK_REASSIGNED_ACTION,
        entityType: 'WorkspaceMember',
        entityId: from.id,
        // Ids (sin nombres ni contenido) para poder responder a un art. 15 RGPD: qué pasó a quién.
        metadata: {
          fromUserId: from.userId, toUserId, processes: processes.count, futureSessions: moved.count,
          processIds, sessionIds: sessions.map((s) => s.id),
          keptSessionIdsWithPrivateNotes: withPrivateNotes.map((s) => s.id),
        },
      },
    });
    return {
      toUserId, processes: processes.count, futureSessions: moved.count,
      keptSessionsWithPrivateNotes: withPrivateNotes.length, archivedProcessNotes: archived.length,
    };
  }

  /** Recuentos de lo que sigue a nombre del miembro (sin pacientes ni contenido). */
  private async pendingWork(db: Pick<Tx, 'clinicalProcess' | 'session' | 'appointmentRequest'>, workspaceId: string, userId: string, now: Date) {
    const [activeProcesses, pausedProcesses, futureSessions, pendingAppointmentRequests] = await Promise.all([
      db.clinicalProcess.count({ where: { workspaceId, therapistId: userId, status: 'ACTIVE' } }),
      db.clinicalProcess.count({ where: { workspaceId, therapistId: userId, status: 'PAUSED' } }),
      db.session.count({ where: { workspaceId, therapistId: userId, status: 'SCHEDULED', startsAt: { gte: now } } }),
      db.appointmentRequest.count({ where: { workspaceId, therapistId: userId, status: 'PENDING' } }),
    ]);
    return { activeProcesses, pausedProcesses, futureSessions, pendingAppointmentRequests };
  }

  private async activeRole(db: Pick<Tx, 'workspaceMember'>, workspaceId: string, userId: string) {
    const member = await db.workspaceMember.findFirst({ where: { workspaceId, userId, status: 'ACTIVE' }, select: { role: true } });
    return member?.role ?? null;
  }
}

function invalidTarget() {
  return new BadRequestException({
    statusCode: 400,
    code: 'INVALID_REASSIGN_TARGET',
    message: 'El destino debe ser otro profesional clínico activo del espacio',
  });
}

/** Una baja o reasignación a la vez por workspace: protege la regla del último OWNER. */
async function lockWorkspaceTeam(tx: Tx, workspaceId: string) {
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `asepsico:member-removal:${workspaceId}`);
}

/** OWNER: a cualquiera menos a sí mismo. ADMIN: solo THERAPIST y ASSISTANT. Resto: 403. */
function assertCanManage(actorRole: WorkspaceRole | null, actorId: string, member: { userId: string; role: WorkspaceRole }) {
  if (actorRole !== 'OWNER' && actorRole !== 'ADMIN') {
    throw new ForbiddenException('Solo propietarios y administradores gestionan el equipo');
  }
  if (member.userId === actorId) {
    throw new BadRequestException({ statusCode: 400, code: 'SELF_REMOVAL_NOT_ALLOWED', message: 'No puedes darte de baja a ti mismo desde el equipo' });
  }
  if (actorRole === 'ADMIN' && (member.role === 'OWNER' || member.role === 'ADMIN')) {
    throw new ForbiddenException('Un administrador solo puede dar de baja a terapeutas y asistentes');
  }
}
