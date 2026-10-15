import { PROCESS_OPENING_REASONS, ProcessOpeningReasonCode } from '../../exceptional-access/exceptional-access.policy';
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

const MODALITIES = [
  'IN_PERSON',
  'ONLINE',
  'HYBRID',
] as const;

export class CreateClinicalProcessDto {
  @ApiProperty()
  @IsString()
  patientId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  therapistId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  consultationReason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(6000)
  goals?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(6000)
  internalNotes?: string;

  @ApiPropertyOptional({ enum: MODALITIES })
  @IsOptional()
  @IsIn(MODALITIES)
  modality?: 'IN_PERSON' | 'ONLINE' | 'HYBRID';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  frequency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  /**
   * H6: obligatorio solo si el paciente tiene historia con otro profesional (si no, se ignora).
   * Sin él, la API responde 400 OPENING_REASON_REQUIRED y la web muestra el selector. Solo
   * OWNER/ADMIN pueden abrir o reactivar sobre historia ajena (THERAPIST: 403).
   */
  @ApiPropertyOptional({ enum: PROCESS_OPENING_REASONS })
  @IsOptional()
  @IsIn(PROCESS_OPENING_REASONS)
  openingReasonCode?: ProcessOpeningReasonCode;
}
