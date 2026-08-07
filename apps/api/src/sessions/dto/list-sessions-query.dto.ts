import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SessionStatus } from '@prisma/client';

export class ListSessionsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() patientId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() therapistId?: string;
  @ApiPropertyOptional({ enum: SessionStatus }) @IsOptional() @IsEnum(SessionStatus) status?: SessionStatus;
  @ApiPropertyOptional({ description: 'ISO date, inicio del rango' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'ISO date, fin del rango' }) @IsOptional() @IsDateString() to?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize?: number = 50;
}
