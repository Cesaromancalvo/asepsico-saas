import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { isClinicalProfile } from '../clinical-access/clinical-access.service';
import { PortalCancelRequestDto, PortalCreateRequestDto, PortalRescheduleRequestDto, PortalSlotsQueryDto } from './dto/scheduling.dto';
import { computeSlots, findGridSlot, Interval } from './slot-calculator';
import { findScheduleConflict, lockPatientBooking, lockTherapistSchedule } from './schedule-lock.util';
import { expireDueRequests, notifyProfessionalOfRequest } from './appointment-request-lifecycle.util';
import { BookingSettings, bookingConflict, isUniqueViolation, loadBookingConfig, slotNotAvailable, tooManyRequests } from './booking-config.util';

/** Sesión del portal ya validada por PortalGuard. Los ids salen del token, nunca del cliente. */
export type PortalUser = { portalAccountId: string; patientId: string; workspaceId: string; accessorType: 'PATIENT' | 'GUARDIAN' };

type Bookable = {
  therapist: { id: string; firstName: string; lastName: string };
  clinicalProcessId: string;
  settings: BookingSettings;
};

const HOUR = 3_600_000;
export const MAX_REQUESTS_PER_HOUR = 5;
export const EMERGENCY_NOTICE = 'Esto no es un canal de urgencias. Si lo necesitas, llama al 024 o al 112.';
const NOT_BOOKABLE_MESSAGE = 'Para pedir cita, contacta con la consulta.';

const PORTAL_REQUEST_SELECT = {
  id: true, type: true, status: true, startsAt: true, endsAt: true, sessionId: true, rejectionReason: true,
  expiresAt: true, createdAt: true, resolvedAt: true, therapist: { select: { id: true, firstName: true, lastName: true } },
} as const;

/**
 * Reserva de citas desde el portal. Reglas (docs/producto/reserva-citas-portal.md):
 *  - Solo profesionales con proceso ACTIVO con el paciente, miembros clínicos del espacio y con la
 *    reserva activada. Cualquier otro id → 404 sin distinguir por qué.
 *  - Los huecos no revelan nada de terceros: solo inicio, fin y profesional. Cita, bloqueo y
 *    solicitud pendiente son indistinguibles (el hueco simplemente no aparece).
 *  - El paciente envía profesional e inicio; el servidor recalcula la rejilla y, con la agenda del
 *    profesional bloqueada, vuelve a comprobar que está libre.
 */
@Injectable()
export class PortalBookingService {
  constructor(private readonly prisma: PrismaService) {}

  async options(portal: PortalUser) {
    const bookable = await this.bookableTherapists(portal);
    const now = new Date();
    const sessions = await this.prisma.session.findMany({
      where: { workspaceId: portal.workspaceId, patientId: portal.patientId, status: 'SCHEDULED', startsAt: { gte: now } },
      orderBy: { startsAt: 'asc' },
      take: 10,
      select: { id: true, startsAt: true, endsAt: true, therapistId: true, therapist: { select: { firstName: true, lastName: true } } },
    });
    const pending = await this.prisma.appointmentRequest.findMany({
      where: { workspaceId: portal.workspaceId, patientId: portal.patientId, status: 'PENDING', sessionId: { in: sessions.map((s) => s.id) } },
      select: { sessionId: true },
    });
    const pendingSessionIds = new Set(pending.map((p) => p.sessionId));
    return {
      canBook: bookable.length > 0,
      message: bookable.length ? null : NOT_BOOKABLE_MESSAGE,
      emergencyNotice: EMERGENCY_NOTICE,
      therapists: bookable.map((b) => b.therapist),
      appointments: sessions.map((s) => {
        const b = bookable.find((x) => x.therapist.id === s.therapistId);
        const changeAllowed = Boolean(b) && s.startsAt.getTime() - now.getTime() >= (b?.settings.cancelNoticeHours ?? 0) * HOUR;
        return {
          id: s.id,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          therapist: { id: s.therapistId, firstName: s.therapist.firstName, lastName: s.therapist.lastName },
          changeAllowed: changeAllowed && !pendingSessionIds.has(s.id),
          hasPendingRequest: pendingSessionIds.has(s.id),
        };
      }),
    };
  }

  async slots(portal: PortalUser, query: PortalSlotsQueryDto) {
    const bookable = await this.resolveBookable(portal, query.therapistId);
    const { workspaceId } = portal;
    const therapistId = bookable.therapist.id;
    const config = await loadBookingConfig(this.prisma, workspaceId, therapistId, bookable.settings);
    const now = new Date();
    const horizon = new Date(now.getTime() + (bookable.settings.maxHorizonDays + 1) * 24 * HOUR);
    const range = { startsAt: { lt: horizon }, endsAt: { gt: now } };

    // Ocupado = citas no canceladas (de cualquier paciente) + solicitudes pendientes + bloqueos.
    // Solo se leen inicio y fin: nada de pacientes, motivos ni estados sale de aquí.
    const [sessions, requests, blocks] = await Promise.all([
      this.prisma.session.findMany({ where: { workspaceId, therapistId, status: { not: 'CANCELLED' }, ...range }, select: { startsAt: true, endsAt: true } }),
      this.prisma.appointmentRequest.findMany({ where: { workspaceId, therapistId, status: 'PENDING', type: { in: ['NEW', 'RESCHEDULE'] }, expiresAt: { gt: now }, ...range }, select: { startsAt: true, endsAt: true } }),
      this.prisma.availabilityBlock.findMany({ where: { workspaceId, therapistId, ...range }, select: { startsAt: true, endsAt: true } }),
    ]);
    const busy: Interval[] = [...sessions, ...blocks, ...requests.filter((r): r is Interval => Boolean(r.startsAt && r.endsAt))];

    const slots = computeSlots({
      ...config.settings,
      timeZone: config.timeZone,
      windows: config.windows,
      now,
      busy,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
    return {
      therapist: bookable.therapist,
      timeZone: config.timeZone,
      slots: slots.map((slot) => ({ startsAt: slot.startsAt, endsAt: slot.endsAt })),
    };
  }

  async listRequests(portal: PortalUser) {
    await this.prisma.$transaction((tx) => expireDueRequests(tx, portal.workspaceId, { patientId: portal.patientId }));
    return this.prisma.appointmentRequest.findMany({
      where: { workspaceId: portal.workspaceId, patientId: portal.patientId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: PORTAL_REQUEST_SELECT,
    });
  }

  createRequest(portal: PortalUser, dto: PortalCreateRequestDto) {
    return this.request(portal, { type: 'NEW', therapistId: dto.therapistId, startsAt: new Date(dto.startsAt) });
  }

  async rescheduleRequest(portal: PortalUser, dto: PortalRescheduleRequestDto) {
    const session = await this.ownChangeableSession(portal, dto.sessionId);
    return this.request(portal, { type: 'RESCHEDULE', therapistId: session.therapistId, startsAt: new Date(dto.startsAt), session });
  }

  async cancelRequest(portal: PortalUser, dto: PortalCancelRequestDto) {
    const session = await this.ownChangeableSession(portal, dto.sessionId);
    return this.request(portal, { type: 'CANCEL', therapistId: session.therapistId, session });
  }

  /** El paciente retira su solicitud pendiente en cualquier momento. */
  async withdraw(portal: PortalUser, requestId: string) {
    const { workspaceId, patientId } = portal;
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.appointmentRequest.updateMany({
        where: { id: requestId, workspaceId, patientId, status: 'PENDING' },
        data: { status: 'WITHDRAWN', heldStartsAt: null, resolvedAt: new Date() },
      });
      if (!count) throw new NotFoundException('Solicitud no encontrada');
      await tx.auditLog.create({
        data: { workspaceId, actorId: null, action: 'APPOINTMENT_REQUEST_WITHDRAWN', entityType: 'AppointmentRequest', entityId: requestId, metadata: { patientId, cause: 'PATIENT', accessorType: portal.accessorType, portalAccountId: portal.portalAccountId } },
      });
      return tx.appointmentRequest.findFirstOrThrow({ where: { id: requestId, workspaceId, patientId }, select: PORTAL_REQUEST_SELECT });
    });
  }

  // ---------------------------------------------------------------------------------------------

  private async request(
    portal: PortalUser,
    input: { type: 'NEW' | 'RESCHEDULE' | 'CANCEL'; therapistId: string; startsAt?: Date; session?: { id: string; startsAt: Date; clinicalProcessId: string | null } },
  ) {
    const { workspaceId, patientId } = portal;
    const bookable = await this.resolveBookable(portal, input.therapistId);
    const therapistId = bookable.therapist.id;
    const now = new Date();

    // Límite por cuenta en base de datos (sobrevive a reinicios y a varias instancias).
    const lastHour = await this.prisma.appointmentRequest.count({
      where: { workspaceId, requestedByAccountId: portal.portalAccountId, createdAt: { gte: new Date(now.getTime() - HOUR) } },
    });
    if (lastHour >= MAX_REQUESTS_PER_HOUR) throw tooManyRequests('Has enviado demasiadas solicitudes. Inténtalo más tarde.');

    if (input.session) this.assertOutsideCancelWindow(input.session.startsAt, bookable.settings, now);

    let slot: Interval | null = null;
    if (input.type !== 'CANCEL') {
      const config = await loadBookingConfig(this.prisma, workspaceId, therapistId, bookable.settings);
      slot = findGridSlot({ ...config.settings, timeZone: config.timeZone, windows: config.windows, now }, input.startsAt as Date);
      if (!slot) throw slotNotAvailable();
    }

    const clinicalProcessId = input.session?.clinicalProcessId ?? bookable.clinicalProcessId;
    const expiresAt = this.expiry(input.type, slot, input.session, bookable.settings);
    if (expiresAt <= now) throw slotNotAvailable();

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await lockPatientBooking(tx, workspaceId, patientId);
        await lockTherapistSchedule(tx, workspaceId, therapistId);
        await expireDueRequests(tx, workspaceId, { therapistId });
        await expireDueRequests(tx, workspaceId, { patientId });
        await this.lockActiveProcess(tx, workspaceId, patientId, therapistId, clinicalProcessId);

        if (input.session) {
          const sameSession = await tx.appointmentRequest.count({ where: { workspaceId, patientId, sessionId: input.session.id, status: 'PENDING' } });
          if (sameSession) throw bookingConflict('REQUEST_ALREADY_PENDING', 'Ya tienes una solicitud pendiente para esta cita.');
          const stillScheduled = await tx.session.count({ where: { id: input.session.id, workspaceId, patientId, status: 'SCHEDULED' } });
          if (!stillScheduled) throw new NotFoundException('Cita no encontrada');
        }
        if (input.type !== 'CANCEL') {
          const pending = await tx.appointmentRequest.count({ where: { workspaceId, patientId, therapistId, status: 'PENDING', type: { in: ['NEW', 'RESCHEDULE'] } } });
          if (pending >= bookable.settings.maxPendingPerPatient) {
            throw bookingConflict('TOO_MANY_PENDING_REQUESTS', 'Ya tienes una solicitud pendiente.');
          }
          const conflict = await findScheduleConflict(tx, {
            workspaceId, therapistId, startsAt: slot!.startsAt, endsAt: slot!.endsAt, includeBlocks: true, now,
            excludeSessionId: input.session?.id,
          });
          if (conflict) throw slotNotAvailable();
        }

        const created = await tx.appointmentRequest.create({
          data: {
            workspaceId, patientId, therapistId, clinicalProcessId, type: input.type, status: 'PENDING',
            sessionId: input.session?.id ?? null,
            startsAt: slot?.startsAt ?? null, endsAt: slot?.endsAt ?? null, heldStartsAt: slot?.startsAt ?? null,
            requestedByAccountId: portal.portalAccountId, accessorType: portal.accessorType, expiresAt,
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            workspaceId, actorId: null, action: 'APPOINTMENT_REQUEST_CREATED', entityType: 'AppointmentRequest', entityId: created.id,
            metadata: {
              patientId, therapistId, type: input.type, sessionId: input.session?.id ?? null,
              startsAt: slot?.startsAt.toISOString() ?? null, accessorType: portal.accessorType, portalAccountId: portal.portalAccountId,
            },
          },
        });
        await notifyProfessionalOfRequest(tx, workspaceId, therapistId, created.id);
        return created.id;
      });
      return this.prisma.appointmentRequest.findFirstOrThrow({ where: { id, workspaceId, patientId }, select: PORTAL_REQUEST_SELECT });
    } catch (error) {
      // Índice único del hueco retenido: otra solicitud se lo llevó a la vez.
      if (isUniqueViolation(error)) throw slotNotAvailable();
      throw error;
    }
  }

  /** Caduca en "inicio del hueco − antelación mínima" (y, si toca una cita, antes de su plazo de cancelación). */
  private expiry(type: string, slot: Interval | null, session: { startsAt: Date } | undefined, settings: BookingSettings): Date {
    const candidates: number[] = [];
    if (slot) candidates.push(slot.startsAt.getTime() - settings.minNoticeHours * HOUR);
    if (session) candidates.push(session.startsAt.getTime() - settings.cancelNoticeHours * HOUR);
    if (type === 'CANCEL' && !session) throw new NotFoundException('Cita no encontrada');
    return new Date(Math.min(...candidates));
  }

  private assertOutsideCancelWindow(startsAt: Date, settings: BookingSettings, now: Date) {
    if (startsAt.getTime() - now.getTime() < settings.cancelNoticeHours * HOUR) {
      throw bookingConflict('WITHIN_CANCELLATION_WINDOW', `Faltan menos de ${settings.cancelNoticeHours} h: llama a la consulta.`);
    }
  }

  /** Cita propia, programada y futura. Otra cosa (ajena, de otro espacio, inexistente) → 404. */
  private async ownChangeableSession(portal: PortalUser, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, workspaceId: portal.workspaceId, patientId: portal.patientId, status: 'SCHEDULED', startsAt: { gt: new Date() } },
      select: { id: true, startsAt: true, therapistId: true, clinicalProcessId: true },
    });
    if (!session) throw new NotFoundException('Cita no encontrada');
    return session;
  }

  /**
   * Dentro de la transacción: el proceso del paciente con ese profesional sigue ACTIVO. El UPDATE
   * bloquea su fila como hace el cierre del proceso, así que solicitud y cierre quedan serializados
   * (si el cierre gana, aquí count = 0; si gana la solicitud, el cierre la rechaza).
   */
  private async lockActiveProcess(tx: Prisma.TransactionClient, workspaceId: string, patientId: string, therapistId: string, clinicalProcessId: string | null) {
    const { count } = clinicalProcessId
      ? await tx.clinicalProcess.updateMany({
          where: { id: clinicalProcessId, workspaceId, patientId, therapistId, status: 'ACTIVE' },
          data: { updatedAt: new Date() },
        })
      : { count: 0 };
    if (!count) throw bookingConflict('BOOKING_UNAVAILABLE', NOT_BOOKABLE_MESSAGE);
  }

  private async resolveBookable(portal: PortalUser, therapistId: string): Promise<Bookable> {
    const found = (await this.bookableTherapists(portal)).find((b) => b.therapist.id === therapistId);
    if (!found) throw new NotFoundException('Profesional no encontrado');
    return found;
  }

  /**
   * Profesionales con los que el paciente puede reservar: paciente ACTIVE (ni pausado, ni de alta,
   * ni archivado, ni bloqueado), proceso ACTIVE con ese profesional, que sigue siendo miembro
   * clínico del espacio y tiene la reserva activada. Todo filtrado por workspaceId y por el
   * patientId del token.
   */
  private async bookableTherapists(portal: PortalUser): Promise<Bookable[]> {
    const { workspaceId, patientId } = portal;
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId, deletedAt: null, status: 'ACTIVE' }, select: { id: true } });
    if (!patient) return [];
    const processes = await this.prisma.clinicalProcess.findMany({
      where: { workspaceId, patientId, status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, therapistId: true },
    });
    const therapistIds = [...new Set(processes.map((p) => p.therapistId))];
    if (!therapistIds.length) return [];
    const [settings, members, users] = await Promise.all([
      this.prisma.therapistAvailability.findMany({ where: { workspaceId, therapistId: { in: therapistIds }, portalBookingEnabled: true } }),
      this.prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: therapistIds } }, select: { userId: true, role: true, isClinician: true } }),
      this.prisma.user.findMany({ where: { id: { in: therapistIds } }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    const result: Bookable[] = [];
    for (const therapistId of therapistIds) {
      const s = settings.find((x) => x.therapistId === therapistId);
      const m = members.find((x) => x.userId === therapistId);
      const u = users.find((x) => x.id === therapistId);
      if (!s || !m || !isClinicalProfile(m) || !u) continue;
      result.push({
        therapist: { id: u.id, firstName: u.firstName, lastName: u.lastName },
        clinicalProcessId: processes.find((p) => p.therapistId === therapistId)!.id,
        settings: {
          portalBookingEnabled: s.portalBookingEnabled, sessionMinutes: s.sessionMinutes, breakMinutes: s.breakMinutes,
          minNoticeHours: s.minNoticeHours, maxHorizonDays: s.maxHorizonDays, cancelNoticeHours: s.cancelNoticeHours,
          maxPendingPerPatient: s.maxPendingPerPatient,
        },
      });
    }
    return result;
  }
}
