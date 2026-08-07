import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PatientStatus } from '@prisma/client';

export type PatientSortField = 'lastName' | 'createdAt';

export class ListPatientsQueryDto {
  @ApiPropertyOptional({ description: 'Búsqueda por nombre, apellidos o correo' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ enum: PatientStatus, description: 'Si se omite, se excluyen los archivados' })
  @IsOptional()
  @IsEnum(PatientStatus)
  status?: PatientStatus;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @ApiPropertyOptional({ enum: ['lastName', 'createdAt'], default: 'lastName' })
  @IsOptional()
  @IsIn(['lastName', 'createdAt'])
  sortBy?: PatientSortField = 'lastName';
}
