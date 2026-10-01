import { ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';
import { decryptField } from '../common/crypto/field-encryption';
import { UpdateOnboardingDto } from './dto/update-onboarding.dto';
import { ClinicalAccessService } from '../clinical-access/clinical-access.service';

const CLINICAL_ROLES = ['OWNER', 'ADMIN', 'THERAPIST'];

@Injectable()
export class DashboardService {
  private readonly access: ClinicalAccessService;

  constructor(private readonly prisma: PrismaService, @Optional() access?: ClinicalAccessService) {
    this.access = access ?? new ClinicalAccessService(prisma);
  }

  private assertAccess(user: AuthUser) {
    if (!CLINICAL_ROLES.includes(user.role)) {
      throw new ForbiddenException('No tienes acceso al dashboard clínico');
    }
  }

  async get(user: AuthUser) {
    this.assertAccess(user);
    const now = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(now); end.setHours(23, 59, 59, 999);

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: user.workspaceId, userId: user.sub } },
      include: { user: { select: { firstName: true, lastName: true } } },
    });
    if (!member) throw new NotFoundException('Miembro no encontrado');

    const therapistFilter = user.role === 'THERAPIST' ? { therapistId: user.sub } : {};
    const patientAccess = user.role === 'THERAPIST'
      ? { clinicalProcesses: { some: { therapistId: user.sub, status: 'ACTIVE' as const } } }
      : {};
    // Avisos con contenido o recuentos clínicos (tareas entregadas, mensajes sin leer): solo de
    // pacientes que el usuario TRATA (clínico con proceso ACTIVO propio). Ser OWNER/ADMIN no basta.
    const clinician = await this.access.isClinician(user.workspaceId, user);
    const treatingAccess = clinician
      ? { clinicalProcesses: { some: { workspaceId: user.workspaceId, therapistId: user.sub, status: 'ACTIVE' as const } } }
      : { id: { in: [] as string[] } };

    const [sessions, patientCount, submittedTasks, unreadMessages, activeWithoutFuture, preferences] = await Promise.all([
      this.prisma.session.findMany({
        where: { workspaceId: user.workspaceId, startsAt: { gte: start, lte: end }, ...therapistFilter },
        orderBy: { startsAt: 'asc' },
        // Vista general: NUNCA notes ni internalSummary (contenido clínico narrativo), ni el
        // título del proceso (puede revelar el motivo clínico): solo su modalidad.
        select: {
          id: true, workspaceId: true, patientId: true, therapistId: true, clinicalProcessId: true,
          startsAt: true, endsAt: true, status: true, type: true, location: true, videoCallUrl: true,
          createdAt: true, updatedAt: true,
          patient: { select: { id: true, firstName: true, lastName: true } },
          clinicalProcess: { select: { modality: true } },
        },
      }),
      this.prisma.patient.count({ where: { workspaceId: user.workspaceId, status: 'ACTIVE', deletedAt: null, ...patientAccess } }),
      this.prisma.therapeuticTask.findMany({
        where: { status: 'SUBMITTED', patient: { workspaceId: user.workspaceId, ...treatingAccess } },
        orderBy: { submittedAt: 'asc' }, take: 5,
        // Solo lo necesario para el aviso: nada de instrucciones, respuestas ni notas.
        select: { id: true, title: true, patient: { select: { id: true, firstName: true, lastName: true } } },
      }),
      this.prisma.message.findMany({
        where: { senderType: 'PATIENT', readByProfessionalAt: null, conversation: { workspaceId: user.workspaceId, patient: treatingAccess } },
        orderBy: { createdAt: 'desc' }, take: 5,
        // Solo metadatos para el aviso: el cuerpo del mensaje (body) NUNCA se carga aquí; se lee
        // en /messages, con su propio control de acceso.
        select: { id: true, createdAt: true, conversation: { select: { patient: { select: { id: true, firstName: true, lastName: true } } } } },
      }),
      this.prisma.patient.findMany({
        where: {
          workspaceId: user.workspaceId, status: 'ACTIVE', deletedAt: null, ...patientAccess,
          sessions: { none: { status: 'SCHEDULED', startsAt: { gt: now } } },
        },
        select: { id: true, firstName: true, lastName: true, updatedAt: true },
        orderBy: { updatedAt: 'asc' }, take: 5,
      }),
      this.prisma.notificationPreference.findUnique({ where: { userId: user.sub } }),
    ]);

    const checklist = [
      { key: 'profile', label: 'Perfil profesional configurado', done: Boolean(member.user.firstName && member.user.lastName), href: '/settings' },
      { key: 'patient', label: 'Primer paciente creado', done: patientCount > 0, href: '/patients?new=true' },
      { key: 'session', label: 'Primera cita programada', done: sessions.length > 0 || await this.prisma.session.count({ where: { workspaceId: user.workspaceId, ...therapistFilter } }) > 0, href: '/agenda?new=true' },
      { key: 'notifications', label: 'Recordatorios revisados', done: Boolean(preferences), href: '/notifications' },
    ];
    const inferredStep = checklist.filter((item) => item.done).length;
    const onboarding = {
      step: Math.max(member.onboardingStep, inferredStep),
      completed: Boolean(member.onboardingCompletedAt) || checklist.every((item) => item.done),
      dismissed: Boolean(member.onboardingDismissedAt),
      checklist,
    };

    return {
      professional: { firstName: member.user.firstName, lastName: member.user.lastName, role: member.role },
      summary: { sessionsToday: sessions.length, pendingReviews: submittedTasks.length, unreadMessages: unreadMessages.length, followUps: activeWithoutFuture.length },
      nextSession: sessions.find((session) => session.startsAt >= now) ?? null,
      sessions,
      attention: [
        ...submittedTasks.map((task) => ({ id: `task-${task.id}`, type: 'TASK_REVIEW', title: `Revisar tarea de ${task.patient.firstName} ${task.patient.lastName}`, subtitle: decryptField(task.title) ?? '', href: `/patients/${task.patient.id}/tasks` })),
        ...unreadMessages.map((message) => ({ id: `message-${message.id}`, type: 'MESSAGE', title: `Mensaje de ${message.conversation.patient.firstName} ${message.conversation.patient.lastName}`, subtitle: 'Pendiente de lectura', href: `/messages?patient=${message.conversation.patient.id}` })),
        ...activeWithoutFuture.map((patient) => ({ id: `followup-${patient.id}`, type: 'FOLLOW_UP', title: `Revisar seguimiento de ${patient.firstName} ${patient.lastName}`, subtitle: 'Sin próxima cita programada', href: `/patients/${patient.id}` })),
      ].slice(0, 8),
      onboarding,
    };
  }

  async updateOnboarding(user: AuthUser, dto: UpdateOnboardingDto) {
    this.assertAccess(user);
    return this.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: user.workspaceId, userId: user.sub } },
      data: {
        ...(dto.step !== undefined ? { onboardingStep: dto.step } : {}),
        ...(dto.completed !== undefined ? { onboardingCompletedAt: dto.completed ? new Date() : null } : {}),
        ...(dto.dismissed !== undefined ? { onboardingDismissedAt: dto.dismissed ? new Date() : null } : {}),
      },
      select: { onboardingStep: true, onboardingCompletedAt: true, onboardingDismissedAt: true },
    });
  }
}
