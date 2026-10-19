import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { assertStaffRole } from '../common/auth/assert-staff-role';
import { isClinicalProfile } from '../clinical-access/clinical-access.service';
import { CreateAvailabilityBlockDto, SetPortalBookingDto, SetTimeZoneDto, UpdateAvailabilityDto } from './dto/scheduling.dto';
import { validateWindows } from './slot-calculator';
import { lockTherapistSchedule } from './schedule-lock.util';
import { DEFAULT_TIME_ZONE, isValidTimeZone } from './time-zone.util';

export const AVAILABILITY_DEFAULTS = {
  portalBookingEnabled: false,
  sessionMinutes: 50,
  breakMinutes: 10,
  minNoticeHours: 24,
  maxHorizonDays: 28,
  cancelNoticeHours: 24,
  maxPendingPerPatient: 1,
} as const;

const SETTINGS_SELECT = {
  portalBookingEnabled: true, sessionMinutes: true, breakMinutes: true, minNoticeHours: true,
  maxHorizonDays: true, cancelNoticeHours: true, maxPendingPerPatient: true, updatedAt: true,
} as const;

const MAX_BLOCK_DAYS = 366;

/**
 * Disponibilidad de los profesionales (franjas, ajustes y bloqueos).
 *  - THERAPIST: ve y edita solo la suya.
 *  - OWNER / ADMIN / ASSISTANT: ven y editan la de cualquier profesional clínico del espacio.
 *  - Activar o desactivar la reserva desde el portal: el propio profesional, OWNER o ADMIN.
 *    ASSISTANT nunca (403 auditado).
 * No hay contenido clínico en nada de esto.
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Profesionales del espacio con agenda, para el selector de la web. THERAPIST ve solo el suyo
   * (spec: "la suya"); OWNER / ADMIN / ASSISTANT ven a todos los profesionales clínicos. Solo id,
   * nombre visible, si ofrece reserva en el portal y la zona horaria del espacio: ni email ni clínica.
   */
  async listProfessionals(actor: AuthUser) {
    assertStaffRole(actor);
    const workspaceId = actor.workspaceId;
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, ...(actor.role === 'THERAPIST' ? { userId: actor.sub } : {}) },
      orderBy: { userId: 'asc' },
      select: { userId: true, role: true, isClinician: true },
    });
    const ids = members.filter(isClinicalProfile).map((m) => m.userId);
    if (!ids.length) return { timeZone: DEFAULT_TIME_ZONE, professionals: [] };
    const [users, settings, workspace] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }),
      this.prisma.therapistAvailability.findMany({ where: { workspaceId, therapistId: { in: ids } }, select: { therapistId: true, portalBookingEnabled: true } }),
      this.prisma.workspace.findFirst({ where: { id: workspaceId }, select: { timeZone: true } }),
    ]);
    const timeZone = workspace?.timeZone ?? DEFAULT_TIME_ZONE;
    const professionals = ids
      .map((id) => {
        const u = users.find((x) => x.id === id);
        if (!u) return null;
        return {
          id,
          name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Profesional',
          portalBookingEnabled: settings.find((x) => x.therapistId === id)?.portalBookingEnabled === true,
          timeZone,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id));
    return { timeZone, professionals };
  }

  async get(actor: AuthUser, therapistId: string) {
    const workspaceId = actor.workspaceId;
    await this.assertCanEdit(actor, therapistId, 'availability-read');
    const [settings, windows, blocks, workspace] = await Promise.all([
      this.prisma.therapistAvailability.findFirst({ where: { workspaceId, therapistId }, select: SETTINGS_SELECT }),
      this.prisma.availabilityWindow.findMany({ where: { workspaceId, therapistId }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }], select: { weekday: true, startMinute: true, endMinute: true } }),
      this.prisma.availabilityBlock.findMany({ where: { workspaceId, therapistId, endsAt: { gte: new Date() } }, orderBy: { startsAt: 'asc' }, take: 200, select: { id: true, startsAt: true, endsAt: true, reason: true } }),
      this.prisma.workspace.findFirst({ where: { id: workspaceId }, select: { timeZone: true } }),
    ]);
    return {
      therapistId,
      timeZone: workspace?.timeZone ?? DEFAULT_TIME_ZONE,
      settings: settings ?? { ...AVAILABILITY_DEFAULTS, updatedAt: null },
      windows,
      blocks,
    };
  }

  async update(actor: AuthUser, therapistId: string, dto: UpdateAvailabilityDto) {
    const workspaceId = actor.workspaceId;
    await this.assertCanEdit(actor, therapistId, 'availability-write');
    const invalid = validateWindows(dto.windows);
    if (invalid) throw new BadRequestException(invalid);

    const settings = {
      sessionMinutes: dto.sessionMinutes,
      breakMinutes: dto.breakMinutes,
      minNoticeHours: dto.minNoticeHours,
      maxHorizonDays: dto.maxHorizonDays,
      cancelNoticeHours: dto.cancelNoticeHours,
      maxPendingPerPatient: dto.maxPendingPerPatient,
    };
    await this.prisma.$transaction(async (tx) => {
      await lockTherapistSchedule(tx, workspaceId, therapistId);
      await tx.therapistAvailability.upsert({
        where: { workspaceId_therapistId: { workspaceId, therapistId } },
        create: { workspaceId, therapistId, ...settings },
        update: settings,
      });
      await tx.availabilityWindow.deleteMany({ where: { workspaceId, therapistId } });
      if (dto.windows.length) {
        await tx.availabilityWindow.createMany({
          data: dto.windows.map((w) => ({ workspaceId, therapistId, weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute })),
        });
      }
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: 'AVAILABILITY_UPDATED', entityType: 'TherapistAvailability', entityId: therapistId, metadata: { therapistId, ...settings, windows: dto.windows.length } },
      });
    });
    return this.get(actor, therapistId);
  }

  async setPortalBooking(actor: AuthUser, therapistId: string, dto: SetPortalBookingDto) {
    const workspaceId = actor.workspaceId;
    assertStaffRole(actor);
    await this.assertClinicianMember(workspaceId, therapistId);
    const allowed = actor.sub === therapistId || actor.role === 'OWNER' || actor.role === 'ADMIN';
    if (!allowed || actor.role === 'ASSISTANT') {
      await this.auditDenied(actor, therapistId, 'portal-booking-toggle');
      throw new ForbiddenException('Solo el propio profesional, el propietario o un administrador pueden activar la reserva online');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.therapistAvailability.upsert({
        where: { workspaceId_therapistId: { workspaceId, therapistId } },
        create: { workspaceId, therapistId, portalBookingEnabled: dto.enabled },
        update: { portalBookingEnabled: dto.enabled },
      });
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: dto.enabled ? 'PORTAL_BOOKING_ENABLED' : 'PORTAL_BOOKING_DISABLED', entityType: 'TherapistAvailability', entityId: therapistId, metadata: { therapistId } },
      });
    });
    return this.get(actor, therapistId);
  }

  /** Bloqueo nuevo. Si pisa citas programadas se guarda igual y se avisa con el recuento (criterio 8). */
  async createBlock(actor: AuthUser, therapistId: string, dto: CreateAvailabilityBlockDto) {
    const workspaceId = actor.workspaceId;
    await this.assertCanEdit(actor, therapistId, 'availability-write');
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      throw new BadRequestException('El fin del bloqueo debe ser posterior al inicio');
    }
    if (endsAt.getTime() - startsAt.getTime() > MAX_BLOCK_DAYS * 86_400_000) {
      throw new BadRequestException('Un bloqueo no puede durar más de un año');
    }
    return this.prisma.$transaction(async (tx) => {
      await lockTherapistSchedule(tx, workspaceId, therapistId);
      const block = await tx.availabilityBlock.create({
        data: { workspaceId, therapistId, startsAt, endsAt, reason: dto.reason, createdById: actor.sub },
        select: { id: true, startsAt: true, endsAt: true, reason: true },
      });
      const overlappingSessions = await tx.session.count({
        where: { workspaceId, therapistId, status: 'SCHEDULED', startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
      });
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: 'AVAILABILITY_BLOCK_CREATED', entityType: 'AvailabilityBlock', entityId: block.id, metadata: { therapistId, reason: dto.reason, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), overlappingSessions } },
      });
      return {
        block,
        overlappingSessions,
        warning: overlappingSessions ? `Hay ${overlappingSessions} cita(s) en este periodo. No se cancelan solas.` : null,
      };
    });
  }

  async deleteBlock(actor: AuthUser, therapistId: string, blockId: string) {
    const workspaceId = actor.workspaceId;
    await this.assertCanEdit(actor, therapistId, 'availability-write');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.availabilityBlock.deleteMany({ where: { id: blockId, workspaceId, therapistId } });
      if (!count) throw new NotFoundException('Bloqueo no encontrado');
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: 'AVAILABILITY_BLOCK_DELETED', entityType: 'AvailabilityBlock', entityId: blockId, metadata: { therapistId } },
      });
    });
    return { ok: true };
  }

  async getTimeZone(actor: AuthUser) {
    assertStaffRole(actor);
    const workspace = await this.prisma.workspace.findFirst({ where: { id: actor.workspaceId }, select: { timeZone: true } });
    return { timeZone: workspace?.timeZone ?? DEFAULT_TIME_ZONE };
  }

  async setTimeZone(actor: AuthUser, dto: SetTimeZoneDto) {
    assertStaffRole(actor);
    if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
      throw new ForbiddenException('Solo el propietario o un administrador pueden cambiar la zona horaria');
    }
    if (!isValidTimeZone(dto.timeZone)) throw new BadRequestException('Zona horaria no válida');
    const workspaceId = actor.workspaceId;
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.workspace.updateMany({ where: { id: workspaceId }, data: { timeZone: dto.timeZone } });
      if (!count) throw new NotFoundException();
      await tx.auditLog.create({
        data: { workspaceId, actorId: actor.sub, action: 'WORKSPACE_TIME_ZONE_CHANGED', entityType: 'Workspace', entityId: workspaceId, metadata: { timeZone: dto.timeZone } },
      });
    });
    return { timeZone: dto.timeZone };
  }

  /** THERAPIST: solo la suya (403 auditado). OWNER/ADMIN/ASSISTANT: cualquier clínico del espacio. */
  private async assertCanEdit(actor: AuthUser, therapistId: string, resource: string) {
    assertStaffRole(actor);
    if (actor.role === 'THERAPIST' && actor.sub !== therapistId) {
      await this.auditDenied(actor, therapistId, resource);
      throw new ForbiddenException('No puedes gestionar la disponibilidad de otro profesional');
    }
    await this.assertClinicianMember(actor.workspaceId, therapistId);
  }

  private async assertClinicianMember(workspaceId: string, therapistId: string) {
    const member = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId: therapistId }, select: { role: true, isClinician: true } });
    if (!member || !isClinicalProfile(member)) throw new NotFoundException('Profesional no encontrado');
  }

  private async auditDenied(actor: AuthUser, therapistId: string, resource: string) {
    await this.prisma.auditLog.create({
      data: { workspaceId: actor.workspaceId, actorId: actor.sub, action: 'AVAILABILITY_ACCESS_DENIED', entityType: 'TherapistAvailability', entityId: therapistId, metadata: { therapistId, resource, role: actor.role } },
    });
  }
}
