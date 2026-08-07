import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SessionStatus,
  SessionType,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { CreateSessionDto } from './dto/create-session.dto';
import { RescheduleSessionDto } from './dto/reschedule-session.dto';
import { ListSessionsQueryDto } from './dto/list-sessions-query.dto';
import { ClosingStatus } from './dto/close-session.dto';
import { UpdateSessionNotesDto } from './dto/update-session-notes.dto';

const THERAPIST_CAPABLE_ROLES = [
  'OWNER',
  'ADMIN',
  'THERAPIST',
];

@Injectable()
export class SessionsService {
  constructor(private prisma: PrismaService) {}

  async list(
    workspaceId: string,
    actor: AuthUser,
    query: ListSessionsQueryDto,
  ) {
    assertStaffRole(actor);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    const where: Prisma.SessionWhereInput = {
      workspaceId,

      ...(query.patientId
        ? { patientId: query.patientId }
        : {}),

      // Un THERAPIST solo ve sus propias sesiones, sea cual sea el therapistId que pida por
      // query (evita que pueda "curiosear" pasando el id de otro compañero).
      ...(actor.role === 'THERAPIST'
        ? { therapistId: actor.sub }
        : query.therapistId
          ? { therapistId: query.therapistId }
          : {}),

      ...(query.status
        ? { status: query.status }
        : {}),

      ...(query.from || query.to
        ? {
            startsAt: {
              ...(query.from
                ? { gte: new Date(query.from) }
                : {}),

              ...(query.to
                ? { lte: new Date(query.to) }
                : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.session.findMany({
        where,
        orderBy: {
          startsAt: 'asc',
        },
        skip: (page - 1) * pageSize,
        take: pageSize,

        include: {
          patient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },

          therapist: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },

          clinicalProcess: {
            select: {
              id: true,
              title: true,
              modality: true,
              status: true,
            },
          },
        },
      }),

      this.prisma.session.count({
        where,
      }),
    ]);

    return {
      data,
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(
          1,
          Math.ceil(total / pageSize),
        ),
      },
    };
  }

  async get(
    workspaceId: string,
    actor: AuthUser,
    id: string,
  ) {
    assertStaffRole(actor);
    const session =
      await this.prisma.session.findFirst({
        where: {
          id,
          workspaceId,
        },

        include: {
          patient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },

          therapist: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },

          // Sin consultationReason ni goals: eso es contenido clínico narrativo y NUNCA se
          // expone desde Sessions, aunque el proceso pertenezca al mismo terapeuta que pide
          // la sesión. Ese contenido solo se sirve desde GET /clinical-processes/:id, que sí
          // aplica el control de acceso por propiedad.
          clinicalProcess: {
            select: {
              id: true,
              title: true,
              modality: true,
              frequency: true,
              status: true,
            },
          },
        },
      });

    if (!session) {
      throw new NotFoundException(
        'Sesión no encontrada',
      );
    }

    // Un THERAPIST solo puede ver el detalle de sus propias sesiones.
    if (actor.role === 'THERAPIST' && session.therapistId !== actor.sub) {
      throw new ForbiddenException('No puedes acceder a la sesión de otro profesional');
    }

    return session;
  }

  async create(
    workspaceId: string,
    actor: AuthUser,
    dto: CreateSessionDto,
  ) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);

    this.assertValidRange(
      startsAt,
      endsAt,
    );

    const patient =
      await this.prisma.patient.findFirst({
        where: {
          id: dto.patientId,
          workspaceId,
        },
      });

    if (!patient) {
      throw new BadRequestException(
        'El paciente no pertenece a este workspace',
      );
    }

    if (patient.status === 'ARCHIVED') {
      throw new BadRequestException(
        'No se puede agendar a un paciente archivado; restáuralo antes',
      );
    }

    const clinicalProcess =
      await this.resolveClinicalProcess(
        workspaceId,
        dto.patientId,
        dto.clinicalProcessId,
      );

    const therapistId =
      await this.resolveTherapistId(
        workspaceId,
        actor,
        dto.therapistId ??
          clinicalProcess.therapistId,
      );

    if (
      therapistId !==
      clinicalProcess.therapistId
    ) {
      throw new BadRequestException(
        'El terapeuta de la sesión debe coincidir con el terapeuta responsable del proceso clínico',
      );
    }

    await this.assertNoOverlap(
      workspaceId,
      therapistId,
      startsAt,
      endsAt,
    );

    const session =
      await this.prisma.$transaction(
        async (tx) => {
          const created =
            await tx.session.create({
              data: {
                workspaceId,
                patientId: dto.patientId,
                therapistId,
                clinicalProcessId:
                  clinicalProcess.id,
                startsAt,
                endsAt,
                type:
                  dto.type ??
                  SessionType.INDIVIDUAL,
                location:
                  dto.location?.trim() ||
                  undefined,
                videoCallUrl:
                  dto.videoCallUrl?.trim() ||
                  undefined,
                notes:
                  dto.notes?.trim() ||
                  undefined,
              },
            });

          await tx.auditLog.create({
            data: {
              workspaceId,
              actorId: actor.sub,
              action: 'SESSION_CREATED',
              entityType: 'Session',
              entityId: created.id,

              metadata: {
                patientId: dto.patientId,
                therapistId,
                clinicalProcessId:
                  clinicalProcess.id,
                type:
                  dto.type ??
                  SessionType.INDIVIDUAL,
              },
            },
          });

          return created;
        },
      );

    return this.get(
      workspaceId,
      actor,
      session.id,
    );
  }

  async reschedule(
    workspaceId: string,
    actor: AuthUser,
    id: string,
    dto: RescheduleSessionDto,
  ) {
    const session = await this.get(
      workspaceId,
      actor,
      id,
    );

    this.assertCanManage(
      actor,
      session.therapistId,
    );

    if (
      session.status !==
      SessionStatus.SCHEDULED
    ) {
      throw new BadRequestException(
        'Solo se puede reprogramar una sesión que sigue programada',
      );
    }

    const startsAt = dto.startsAt
      ? new Date(dto.startsAt)
      : session.startsAt;

    const endsAt = dto.endsAt
      ? new Date(dto.endsAt)
      : session.endsAt;

    this.assertValidRange(
      startsAt,
      endsAt,
    );

    if (
      dto.startsAt ||
      dto.endsAt
    ) {
      await this.assertNoOverlap(
        workspaceId,
        session.therapistId,
        startsAt,
        endsAt,
        id,
      );
    }

    const updated =
      await this.prisma.session.update({
        where: {
          id,
        },

        data: {
          startsAt,
          endsAt,
          notes:
            dto.notes ??
            session.notes,
        },
      });

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action: 'SESSION_RESCHEDULED',
        entityType: 'Session',
        entityId: id,

        metadata: {
          from: {
            startsAt:
              session.startsAt,
            endsAt:
              session.endsAt,
          },

          to: {
            startsAt,
            endsAt,
          },
        },
      },
    });

    return this.get(
      workspaceId,
      actor,
      updated.id,
    );
  }
  async updateNotes(
    workspaceId: string,
    actor: AuthUser,
    id: string,
    dto: UpdateSessionNotesDto,
  ) {
    const session = await this.get(
      workspaceId,
      actor,
      id,
    );

    this.assertCanManage(
      actor,
      session.therapistId,
    );

    if (
      dto.notes === undefined &&
      dto.internalSummary === undefined
    ) {
      throw new BadRequestException(
        'Debes indicar al menos un campo para actualizar',
      );
    }

    const updated =
      await this.prisma.session.update({
        where: {
          id,
        },

        data: {
          ...(dto.notes !== undefined
            ? {
                notes:
                  dto.notes.trim() ||
                  null,
              }
            : {}),

          ...(dto.internalSummary !== undefined
            ? {
                internalSummary:
                  dto.internalSummary.trim() ||
                  null,
              }
            : {}),
        },
      });

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action: 'SESSION_NOTES_UPDATED',
        entityType: 'Session',
        entityId: id,

        metadata: {
          notesUpdated:
            dto.notes !== undefined,
          internalSummaryUpdated:
            dto.internalSummary !== undefined,
        },
      },
    });

    return this.get(
      workspaceId,
      actor,
      updated.id,
    );
  }
  async close(
    workspaceId: string,
    actor: AuthUser,
    id: string,
    target: ClosingStatus,
  ) {
    const session = await this.get(
      workspaceId,
      actor,
      id,
    );

    this.assertCanManage(
      actor,
      session.therapistId,
    );

    if (
      session.status !==
      SessionStatus.SCHEDULED
    ) {
      throw new BadRequestException(
        'La sesión ya está cerrada',
      );
    }

    const updated =
      await this.prisma.session.update({
        where: {
          id,
        },

        data: {
          status: target,
        },
      });

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action:
          'SESSION_STATUS_CHANGED',
        entityType: 'Session',
        entityId: id,

        metadata: {
          from:
            SessionStatus.SCHEDULED,
          to: target,
        },
      },
    });

    return this.get(
      workspaceId,
      actor,
      updated.id,
    );
  }

  private async resolveClinicalProcess(
    workspaceId: string,
    patientId: string,
    requestedProcessId?: string,
  ) {
    if (requestedProcessId) {
      const clinicalProcess =
        await this.prisma.clinicalProcess.findFirst({
          where: {
            id: requestedProcessId,
            workspaceId,
            patientId,
          },
        });

      if (!clinicalProcess) {
        throw new BadRequestException(
          'El proceso clínico indicado no pertenece al paciente',
        );
      }

      if (
        clinicalProcess.status !==
        'ACTIVE'
      ) {
        throw new BadRequestException(
          'Solo se pueden crear sesiones dentro de un proceso clínico activo',
        );
      }

      return clinicalProcess;
    }

    const activeProcesses =
      await this.prisma.clinicalProcess.findMany({
        where: {
          workspaceId,
          patientId,
          status: 'ACTIVE',
        },

        orderBy: {
          updatedAt: 'desc',
        },

        take: 2,
      });

    if (
      activeProcesses.length === 0
    ) {
      throw new BadRequestException(
        'El paciente no tiene ningún proceso clínico activo. Abre un proceso antes de programar la sesión.',
      );
    }

    if (
      activeProcesses.length > 1
    ) {
      throw new BadRequestException(
        'El paciente tiene varios procesos clínicos activos. Debes indicar a cuál pertenece la sesión.',
      );
    }

    return activeProcesses[0];
  }

  private assertValidRange(
    startsAt: Date,
    endsAt: Date,
  ) {
    if (
      Number.isNaN(
        startsAt.getTime(),
      ) ||
      Number.isNaN(
        endsAt.getTime(),
      )
    ) {
      throw new BadRequestException(
        'Fechas de sesión no válidas',
      );
    }

    if (
      endsAt <= startsAt
    ) {
      throw new BadRequestException(
        'endsAt debe ser posterior a startsAt',
      );
    }
  }

  private async resolveTherapistId(
    workspaceId: string,
    actor: AuthUser,
    requestedTherapistId?: string,
  ) {
    if (
      actor.role === 'THERAPIST'
    ) {
      if (
        requestedTherapistId &&
        requestedTherapistId !==
          actor.sub
      ) {
        throw new ForbiddenException(
          'Un terapeuta solo puede agendarse sesiones a sí mismo',
        );
      }

      return actor.sub;
    }

    if (!requestedTherapistId) {
      throw new BadRequestException(
        'therapistId es obligatorio para agendar en nombre de un profesional',
      );
    }

    const membership =
      await this.prisma.workspaceMember.findFirst({
        where: {
          userId:
            requestedTherapistId,
          workspaceId,
        },
      });

    if (
      !membership ||
      !THERAPIST_CAPABLE_ROLES.includes(
        membership.role,
      )
    ) {
      throw new BadRequestException(
        'El profesional indicado no pertenece a este workspace o no puede dar sesiones',
      );
    }

    return requestedTherapistId;
  }

  private assertCanManage(
    actor: AuthUser,
    therapistId: string,
  ) {
    if (
      actor.role ===
        'THERAPIST' &&
      actor.sub !== therapistId
    ) {
      throw new ForbiddenException(
        'No puedes modificar sesiones de otro profesional',
      );
    }
  }

  private async assertNoOverlap(
    workspaceId: string,
    therapistId: string,
    startsAt: Date,
    endsAt: Date,
    excludeId?: string,
  ) {
    const overlapping =
      await this.prisma.session.findFirst({
        where: {
          workspaceId,
          therapistId,

          status: {
            not:
              SessionStatus.CANCELLED,
          },

          ...(excludeId
            ? {
                id: {
                  not: excludeId,
                },
              }
            : {}),

          startsAt: {
            lt: endsAt,
          },

          endsAt: {
            gt: startsAt,
          },
        },
      });

    if (overlapping) {
      throw new BadRequestException(
        'El profesional ya tiene una sesión en ese horario',
      );
    }
  }
}