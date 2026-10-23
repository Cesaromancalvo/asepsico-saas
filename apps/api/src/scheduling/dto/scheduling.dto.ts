import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const BLOCK_REASONS = ['VACATION', 'TRAINING', 'PERSONAL', 'OTHER'] as const;
export const REJECTION_REASONS = ['SLOT_UNAVAILABLE', 'DISCUSS_IN_SESSION', 'CONTACT_PRACTICE'] as const;
export const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'] as const;

// ---------- Profesional ----------

export class AvailabilityWindowDto {
  /** 1 = lunes … 7 = domingo. */
  @IsInt() @Min(1) @Max(7)
  weekday!: number;

  /** Minutos desde las 00:00 en hora local del espacio, múltiplo de 15. */
  @IsInt() @Min(0) @Max(1425)
  startMinute!: number;

  @IsInt() @Min(15) @Max(1440)
  endMinute!: number;
}

/**
 * Ajustes y franjas (sustituye las franjas completas). La activación de la reserva desde el
 * portal NO va aquí: tiene su propio endpoint porque la recepción no puede cambiarla.
 */
export class UpdateAvailabilityDto {
  @IsInt() @Min(30) @Max(120)
  sessionMinutes!: number;

  @IsInt() @Min(0) @Max(60)
  breakMinutes!: number;

  @IsInt() @Min(2) @Max(168)
  minNoticeHours!: number;

  @IsInt() @Min(7) @Max(60)
  maxHorizonDays!: number;

  @IsInt() @Min(0) @Max(72)
  cancelNoticeHours!: number;

  @IsInt() @Min(1) @Max(3)
  maxPendingPerPatient!: number;

  @IsArray() @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityWindowDto)
  windows!: AvailabilityWindowDto[];
}

export class SetPortalBookingDto {
  @IsBoolean()
  enabled!: boolean;
}

/** Bloqueo puntual: motivo de lista cerrada, sin texto libre. */
export class CreateAvailabilityBlockDto {
  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsEnum(BLOCK_REASONS)
  reason!: (typeof BLOCK_REASONS)[number];
}

export class SetTimeZoneDto {
  @IsString() @MaxLength(64)
  timeZone!: string;
}

export class ListAppointmentRequestsQueryDto {
  @IsOptional() @IsIn(REQUEST_STATUSES)
  status?: (typeof REQUEST_STATUSES)[number];

  @IsOptional() @IsString() @MaxLength(64)
  therapistId?: string;
}

export class RejectAppointmentRequestDto {
  @IsEnum(REJECTION_REASONS)
  reason!: (typeof REJECTION_REASONS)[number];
}

// ---------- Portal ----------

export class PortalSlotsQueryDto {
  @IsString() @MaxLength(64)
  therapistId!: string;

  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;
}

/** El paciente solo envía profesional e inicio: el servidor recalcula que el hueco existe y está libre. */
export class PortalCreateRequestDto {
  @IsString() @MaxLength(64)
  therapistId!: string;

  @IsDateString()
  startsAt!: string;
}

export class PortalRescheduleRequestDto {
  @IsString() @MaxLength(64)
  sessionId!: string;

  @IsDateString()
  startsAt!: string;
}

export class PortalCancelRequestDto {
  @IsString() @MaxLength(64)
  sessionId!: string;
}
