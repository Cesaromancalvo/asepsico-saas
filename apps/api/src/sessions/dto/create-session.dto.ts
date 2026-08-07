import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { SessionType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateSessionDto {
  @ApiProperty()
  @IsString()
  patientId!: string;

  @ApiPropertyOptional({
    description:
      'Proceso clínico asociado. Si no se envía, se utilizará automáticamente el proceso activo del paciente.',
  })
  @IsOptional()
  @IsString()
  clinicalProcessId?: string;

  @ApiPropertyOptional({
    description:
      'Requerido si quien agenda no es el propio terapeuta.',
  })
  @IsOptional()
  @IsString()
  therapistId?: string;

  @ApiProperty()
  @IsDateString()
  startsAt!: string;

  @ApiProperty()
  @IsDateString()
  endsAt!: string;

  @ApiPropertyOptional({
    enum: SessionType,
    default: SessionType.INDIVIDUAL,
  })
  @IsOptional()
  @IsEnum(SessionType)
  type?: SessionType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  videoCallUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}