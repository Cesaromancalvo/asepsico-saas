import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class PatientAgendaQueryDto {
  @ApiPropertyOptional({ description: 'ISO date, inicio del rango (startsAt >= from)' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'ISO date, fin del rango (startsAt <= to)' }) @IsOptional() @IsDateString() to?: string;
}
