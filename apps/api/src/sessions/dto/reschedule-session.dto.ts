import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Instante ISO 8601 con zona explícita (`Z` o `±hh:mm`). Sin zona, `new Date()` lo interpretaría
 * en la hora del servidor: la web convierte antes la hora local del espacio (Workspace.timeZone).
 */
const ISO_WITH_ZONE = /(Z|[+-]\d{2}:\d{2})$/;
const ZONE_MESSAGE = 'La fecha debe incluir la zona horaria (Z o ±hh:mm)';

/** PATCH /sessions/:id/reschedule («Mover cita»): inicio y fin nuevos, ambos obligatorios. */
export class RescheduleSessionTimesDto {
  @ApiProperty({ example: '2026-11-03T19:30:00+01:00' })
  @IsDateString() @Matches(ISO_WITH_ZONE, { message: ZONE_MESSAGE }) startsAt!: string;

  @ApiProperty({ example: '2026-11-03T20:20:00+01:00' })
  @IsDateString() @Matches(ISO_WITH_ZONE, { message: ZONE_MESSAGE }) endsAt!: string;
}

/** PATCH /sessions/:id (heredado; la web usa /reschedule). Mismas reglas, admite notas. */
export class RescheduleSessionDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() @Matches(ISO_WITH_ZONE, { message: ZONE_MESSAGE }) startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() @Matches(ISO_WITH_ZONE, { message: ZONE_MESSAGE }) endsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
