import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ClinicalProcessStatus } from '@prisma/client';

export class ListClinicalProcessesQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() patientId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() therapistId?: string;
  @ApiPropertyOptional({ enum: ClinicalProcessStatus }) @IsOptional() @IsEnum(ClinicalProcessStatus) status?: ClinicalProcessStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) q?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize?: number = 20;
}
