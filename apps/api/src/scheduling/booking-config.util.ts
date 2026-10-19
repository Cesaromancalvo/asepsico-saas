import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WeeklyWindow } from './slot-calculator';
import { DEFAULT_TIME_ZONE } from './time-zone.util';

export type BookingSettings = {
  portalBookingEnabled: boolean;
  sessionMinutes: number;
  breakMinutes: number;
  minNoticeHours: number;
  maxHorizonDays: number;
  cancelNoticeHours: number;
  maxPendingPerPatient: number;
};

export type BookingConfig = { settings: BookingSettings; windows: WeeklyWindow[]; timeZone: string };

/** Ajustes, franjas y zona horaria de un profesional, siempre acotados al espacio. */
export async function loadBookingConfig(prisma: PrismaService, workspaceId: string, therapistId: string, settings: BookingSettings): Promise<BookingConfig> {
  const [windows, workspace] = await Promise.all([
    prisma.availabilityWindow.findMany({ where: { workspaceId, therapistId }, select: { weekday: true, startMinute: true, endMinute: true } }),
    prisma.workspace.findFirst({ where: { id: workspaceId }, select: { timeZone: true } }),
  ]);
  return { settings, windows, timeZone: workspace?.timeZone ?? DEFAULT_TIME_ZONE };
}

/** 409 con código estable para que el portal refresque los huecos. */
export function slotNotAvailable(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'SLOT_NOT_AVAILABLE',
    message: 'Ese hueco ya no está disponible. Elige otro.',
  });
}

export function bookingConflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', code, message });
}

export function tooManyRequests(message: string): HttpException {
  return new HttpException({ statusCode: 429, error: 'Too Many Requests', message }, HttpStatus.TOO_MANY_REQUESTS);
}

/** ¿Es un error de índice único de Prisma (P2002)? El hueco retenido ya lo tiene otra solicitud. */
export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'P2002');
}
