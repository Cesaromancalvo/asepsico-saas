import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PatientStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { ListPatientsQueryDto } from './dto/list-patients-query.dto';
import { AssignableStatus } from './dto/change-status.dto';

const ALLOWED_TRANSITIONS: Record<PatientStatus, AssignableStatus[]> = {
  ACTIVE: ['PAUSED', 'DISCHARGED'],
  PAUSED: ['ACTIVE', 'DISCHARGED'],
  DISCHARGED: ['ACTIVE'],
  ARCHIVED: [],
};

@Injectable()
export class PatientCoreService {
  constructor(protected readonly prisma: PrismaService) {}
  async list(
    workspaceId: string,
    actor: AuthUser,
    query: ListPatientsQueryDto,
  ) {
    assertStaffRole(actor);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const sortBy = query.sortBy ?? 'lastName';
    const now = new Date();

    const where: Prisma.PatientWhereInput = {
      workspaceId,
      ...(actor.role === 'THERAPIST'
        ? { clinicalProcesses: { some: { workspaceId, therapistId: actor.sub } } }
        : {}),

      ...(query.status
        ? { status: query.status }
        : {
            status: {
              not: PatientStatus.ARCHIVED,
            },
          }),

      ...(query.q
        ? {
            OR: [
              {
                firstName: {
                  contains: query.q,
                  mode: 'insensitive',
                },
              },
              {
                lastName: {
                  contains: query.q,
                  mode: 'insensitive',
                },
              },
              {
                email: {
                  contains: query.q,
                  mode: 'insensitive',
                },
              },
              {
                phone: {
                  contains: query.q,
                  mode: 'insensitive',
                },
              },
              {
                consultationReason: {
                  contains: query.q,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.PatientOrderByWithRelationInput[] =
      sortBy === 'createdAt'
        ? [{ createdAt: 'desc' }]
        : [{ lastName: 'asc' }, { firstName: 'asc' }];

    const [patients, total] = await Promise.all([
      this.prisma.patient.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,

        include: {
          _count: {
            select: {
              sessions: true,
              clinicalProcesses: true,
            },
          },

          clinicalProcesses: {
            ...(actor.role === 'THERAPIST' ? { where: { workspaceId, therapistId: actor.sub } } : {}),
            // El más reciente, sea cual sea su estado (no solo ACTIVE): así un proceso
            // pausado o dado de alta sigue siendo visible y se puede reactivar desde aquí,
            // en vez de desaparecer de la vista.
            orderBy: {
              updatedAt: 'desc',
            },
            take: 1,
            select: {
              id: true,
              title: true,
              status: true,
              modality: true,
              frequency: true,
              startedAt: true,
              therapist: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
          },

          sessions: {
            where: {
              ...(actor.role === 'THERAPIST' ? { therapistId: actor.sub } : {}),
              startsAt: {
                lt: now,
              },
            },
            orderBy: {
              startsAt: 'desc',
            },
            take: 1,
            select: {
              id: true,
              startsAt: true,
              endsAt: true,
              status: true,
              type: true,
            },
          },
        },
      }),

      this.prisma.patient.count({
        where,
      }),
    ]);

    const patientIds = patients.map(
      (patient) => patient.id,
    );

    const nextSessions =
      patientIds.length > 0
        ? await this.prisma.session.findMany({
            where: {
              workspaceId,
              patientId: {
                in: patientIds,
              },
              startsAt: {
                gte: now,
              },
              status: 'SCHEDULED',
              ...(actor.role === 'THERAPIST' ? { therapistId: actor.sub } : {}),
            },
            orderBy: {
              startsAt: 'asc',
            },
            select: {
              id: true,
              patientId: true,
              startsAt: true,
              endsAt: true,
              status: true,
              type: true,
            },
          })
        : [];

    const nextSessionByPatient = new Map<
      string,
      (typeof nextSessions)[number]
    >();

    for (const session of nextSessions) {
      if (!nextSessionByPatient.has(session.patientId)) {
        nextSessionByPatient.set(
          session.patientId,
          session,
        );
      }
    }

    const data = patients.map((patient) => {
      const {
        _count,
        clinicalProcesses,
        sessions,
        ...patientData
      } = patient;

      const activeProcess =
        clinicalProcesses[0] ?? null;

      return {
        ...patientData,

        summary: {
          processCount: _count.clinicalProcesses,
          sessionCount: _count.sessions,
          activeProcess,
          lastSession: sessions[0] ?? null,
          nextSession:
            nextSessionByPatient.get(patient.id) ?? null,
          therapist:
            activeProcess?.therapist ?? null,
        },
      };
    });

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

  async get(workspaceId: string, actor: AuthUser, id: string) {
    assertStaffRole(actor);
    const now = new Date();

    // Igual que list(): solo se seleccionan campos operativos/administrativos de los procesos
    // clínicos y las sesiones. El contenido clínico narrativo (motivo de consulta, objetivos,
    // notas internas, notas de sesión) NUNCA se expone a través de Patients, ni siquiera al
    // propio terapeuta dueño del proceso: eso solo se sirve desde GET /clinical-processes/:id
    // y GET /sessions/:id, que sí aplican el control de acceso por rol/propiedad. Servirlo aquí
    // se saltaría ese control (por ejemplo, un THERAPIST vería las notas privadas de otro
    // profesional sobre el mismo paciente, o un ASSISTANT vería contenido clínico).
    const patient = await this.prisma.patient.findFirst({
      where: {
        id,
        workspaceId,
        ...(actor.role === 'THERAPIST'
          ? { clinicalProcesses: { some: { workspaceId, therapistId: actor.sub } } }
          : {}),
      },
      include: {
        _count: { select: { sessions: true, clinicalProcesses: true } },
        clinicalProcesses: {
          ...(actor.role === 'THERAPIST' ? { where: { workspaceId, therapistId: actor.sub } } : {}),
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            title: true,
            status: true,
            modality: true,
            frequency: true,
            startedAt: true,
            updatedAt: true,
            therapist: { select: { id: true, firstName: true, lastName: true, email: true } },
            _count: { select: { sessions: true } },
          },
        },
        sessions: {
          ...(actor.role === 'THERAPIST' ? { where: { therapistId: actor.sub } } : {}),
          orderBy: { startsAt: 'desc' },
          select: {
            id: true,
            clinicalProcessId: true,
            therapistId: true,
            startsAt: true,
            endsAt: true,
            status: true,
            type: true,
            location: true,
            videoCallUrl: true,
            therapist: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    if (!patient) {
      throw new NotFoundException('Paciente no encontrado');
    }

    const { _count, clinicalProcesses, sessions, ...patientData } = patient;

    const activeProcess = clinicalProcesses.find((process) => process.status === 'ACTIVE') ?? null;

    const lastSession = sessions.find((session) => new Date(session.startsAt) < now) ?? null;

    const nextSession =
      [...sessions]
        .filter((session) => session.status === 'SCHEDULED' && new Date(session.startsAt) >= now)
        .sort((first, second) => new Date(first.startsAt).getTime() - new Date(second.startsAt).getTime())[0] ?? null;

    return {
      ...patientData,
      summary: {
        processCount: _count.clinicalProcesses,
        sessionCount: _count.sessions,
        activeProcess,
        allProcesses: clinicalProcesses,
        recentSessions: sessions.slice(0, 20),
        lastSession,
        nextSession,
        therapist: activeProcess?.therapist ?? null,
      },
    };
  }

  async create(
    workspaceId: string,
    actor: AuthUser,
    dto: CreatePatientDto,
  ) {
    assertStaffRole(actor);
    return this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.create({
        data: {
          workspaceId,
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone,
          birthDate: dto.birthDate
            ? new Date(dto.birthDate)
            : undefined,
          consultationReason:
            dto.consultationReason,
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'PATIENT_CREATED',
          entityType: 'Patient',
          entityId: patient.id,
        },
      });

      return patient;
    });
  }

  async update(
    workspaceId: string,
    actor: AuthUser,
    id: string,
    dto: UpdatePatientDto,
  ) {
    await this.assertActive(workspaceId, actor, id);

    const { count } =
      await this.prisma.patient.updateMany({
        where: {
          id,
          workspaceId,
        },
        data: {
          ...dto,
          birthDate: dto.birthDate
            ? new Date(dto.birthDate)
            : undefined,
        },
      });

    if (count === 0) {
      throw new NotFoundException(
        'Paciente no encontrado',
      );
    }

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action: 'PATIENT_UPDATED',
        entityType: 'Patient',
        entityId: id,
      },
    });

    return this.get(workspaceId, actor, id);
  }

  async changeStatus(
    workspaceId: string,
    actor: AuthUser,
    id: string,
    target: AssignableStatus,
  ) {
    const patient = await this.get(
      workspaceId,
      actor,
      id,
    );

    if (patient.status === target) {
      return patient;
    }

    const allowed =
      ALLOWED_TRANSITIONS[patient.status] ?? [];

    if (!allowed.includes(target)) {
      throw new BadRequestException(
        `No se puede pasar de ${patient.status} a ${target}`,
      );
    }

    const updated =
      await this.prisma.patient.update({
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
        action: 'PATIENT_STATUS_CHANGED',
        entityType: 'Patient',
        entityId: id,
        metadata: {
          from: patient.status,
          to: target,
        },
      },
    });

    return updated;
  }

  async archive(
    workspaceId: string,
    actor: AuthUser,
    id: string,
  ) {
    await this.assertActive(workspaceId, actor, id);

    const { count } =
      await this.prisma.patient.updateMany({
        where: {
          id,
          workspaceId,
        },
        data: {
          status: 'ARCHIVED',
          deletedAt: new Date(),
        },
      });

    if (count === 0) {
      throw new NotFoundException(
        'Paciente no encontrado',
      );
    }

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action: 'PATIENT_ARCHIVED',
        entityType: 'Patient',
        entityId: id,
      },
    });

    return {
      success: true,
    };
  }

  async restore(
    workspaceId: string,
    actor: AuthUser,
    id: string,
  ) {
    const patient = await this.get(
      workspaceId,
      actor,
      id,
    );

    if (patient.status !== 'ARCHIVED') {
      throw new BadRequestException(
        'El paciente no está archivado',
      );
    }

    const restored =
      await this.prisma.patient.update({
        where: {
          id,
        },
        data: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      });

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: actor.sub,
        action: 'PATIENT_RESTORED',
        entityType: 'Patient',
        entityId: id,
      },
    });

    return restored;
  }

  private async assertActive(
    workspaceId: string,
    actor: AuthUser,
    id: string,
  ) {
    const patient = await this.get(
      workspaceId,
      actor,
      id,
    );

    if (patient.status === 'ARCHIVED') {
      throw new BadRequestException(
        'El paciente está archivado; restáuralo antes de modificarlo',
      );
    }

    return patient;
  }
}
