import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PatientStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { encryptField } from '../common/crypto/field-encryption';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { ListPatientsQueryDto } from './dto/list-patients-query.dto';
import { decryptPatient } from './patient-crypto.util';
import { NON_MODIFIABLE_STATUSES, updatePatientScoped } from './patient-write.util';
import { applyPortalAccessModeChange } from '../portal/portal-access-mode.util';

// El ciclo de vida (changeStatus, archive, restore, block) vive en PatientLifecycleService.
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
            // Ni archivados ni bloqueados aparecen en el listado normal por defecto. Un
            // paciente bloqueado (art. 32 LOPDGDD) está fuera de cualquier uso operativo
            // habitual — solo se accede a él de forma explícita, nunca navegando la lista.
            status: {
              notIn: [PatientStatus.ARCHIVED, PatientStatus.BLOCKED],
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
              // consultationReason ya no se incluye en la búsqueda: al estar cifrado en la
              // base de datos, un "contains" sobre el texto cifrado nunca encontraría
              // coincidencias reales y daría resultados incompletos sin avisar.
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
        ...decryptPatient(patientData),

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
      ...decryptPatient(patientData),
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
          consultationReason: encryptField(
            dto.consultationReason,
          ),
          // Si no se indica, se aplica el valor por defecto del esquema (PATIENT_ONLY).
          portalAccessMode: dto.portalAccessMode,
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'PATIENT_CREATED',
          entityType: 'Patient',
          entityId: patient.id,
          // Solo el nombre del modo de acceso al portal (dato de configuración, no personal).
          metadata: { portalAccessMode: patient.portalAccessMode },
        },
      });

      return decryptPatient(patient);
    });
  }

  async update(
    workspaceId: string,
    actor: AuthUser,
    id: string,
    dto: UpdatePatientDto,
  ) {
    await this.assertActive(workspaceId, actor, id);

    // Escritura y auditoría en la misma transacción: si falla la auditoría no se confirma
    // la modificación (mismo patrón que create()). Si cambia portalAccessMode, la revocación
    // de cuentas de portal incompatibles y su auditoría van también aquí dentro.
    await this.prisma.$transaction(async (tx) => {
      let previousMode: string | undefined;
      if (dto.portalAccessMode !== undefined) {
        // Primero se bloquea la fila del paciente (UPDATE sin cambio de negocio) y después se lee
        // el modo anterior: con la fila bloqueada, un enable() concurrente (que hace
        // compare-and-set sobre esta fila) no puede colarse entre la lectura y la revocación.
        await tx.patient.updateMany({ where: { id, workspaceId }, data: { updatedAt: new Date() } });
        const locked = await tx.patient.findFirst({ where: { id, workspaceId }, select: { portalAccessMode: true } });
        previousMode = locked?.portalAccessMode;
      }

      // Guard de estado en el propio UPDATE: si entre assertActive y la escritura el paciente
      // pasó a ARCHIVED o BLOCKED → 409 sin escribir.
      await updatePatientScoped(
        tx,
        workspaceId,
        id,
        { status: { notIn: [...NON_MODIFIABLE_STATUSES] } },
        {
          ...dto,
          consultationReason: dto.consultationReason !== undefined
            ? encryptField(dto.consultationReason)
            : undefined,
          birthDate: dto.birthDate
            ? new Date(dto.birthDate)
            : undefined,
        },
      );

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'PATIENT_UPDATED',
          entityType: 'Patient',
          entityId: id,
        },
      });

      if (dto.portalAccessMode !== undefined) {
        await applyPortalAccessModeChange(tx, {
          workspaceId,
          actorId: actor.sub,
          patientId: id,
          previousMode,
          newMode: dto.portalAccessMode,
        });
      }
    });

    return this.get(workspaceId, actor, id);
  }

  // Público porque PatientLifecycleService.archive() lo reutiliza; solo lee (vía get(), con
  // filtro por workspaceId y control de rol) y comprueba que el paciente no esté archivado
  // ni bloqueado. BadRequest (400), igual que el resto de validaciones de estado del módulo
  // (transición no permitida, "ya está bloqueado", "no está archivado"): es un estado estable
  // conocido por el cliente. El 409 se reserva para la carrera detectada al escribir.
  async assertActive(
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

    // Un paciente bloqueado (art. 32 LOPDGDD) no se modifica ni se archiva: archivarlo sería
    // la puerta para "desbloquearlo" después vía restore().
    if (patient.status === PatientStatus.BLOCKED) {
      throw new BadRequestException(
        'Los datos del paciente están bloqueados y no pueden modificarse',
      );
    }

    return patient;
  }
}
