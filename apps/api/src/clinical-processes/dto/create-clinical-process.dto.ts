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
}
