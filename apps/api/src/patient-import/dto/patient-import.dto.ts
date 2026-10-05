import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { IGNORE_COLUMN, IMPORT_FIELDS } from '../column-mapping';
import { IMPORT_LIMITS } from '../import-limits';

// Solo campos administrativos o "no importar": no existe ningún destino clínico que asignar.
const COLUMN_TARGETS = [...IMPORT_FIELDS, IGNORE_COLUMN];

export class TemplateQueryDto {
  @ApiProperty({ enum: ['csv', 'xlsx'] }) @IsIn(['csv', 'xlsx']) format!: 'csv' | 'xlsx';
}

export class UploadQueryDto {
  @ApiPropertyOptional({ description: 'Índice (base 0) de la hoja del XLSX; por defecto la primera' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(99) sheet?: number;
}

export class ColumnAssignmentDto {
  @ApiProperty() @IsInt() @Min(0) @Max(IMPORT_LIMITS.MAX_COLUMNS - 1) index!: number;
  @ApiProperty({ enum: COLUMN_TARGETS }) @IsIn(COLUMN_TARGETS) field!: (typeof COLUMN_TARGETS)[number];
}

export class PreviewImportDto {
  @ApiProperty({ description: 'false si la primera fila ya son datos (sin cabeceras)' }) @IsBoolean() hasHeaderRow!: boolean;

  @ApiProperty({ type: [ColumnAssignmentDto] })
  @IsArray() @ArrayMaxSize(IMPORT_LIMITS.MAX_COLUMNS) @ValidateNested({ each: true }) @Type(() => ColumnAssignmentDto)
  columns!: ColumnAssignmentDto[];
}

export const DUPLICATE_ACTIONS = ['SKIP', 'CREATE', 'COMPLETE'] as const;
export type DuplicateAction = (typeof DUPLICATE_ACTIONS)[number];

export class DuplicateDecisionDto {
  @ApiProperty({ description: 'Número de fila (el de la vista previa)' }) @IsInt() @Min(1) row!: number;
  @ApiProperty({ enum: DUPLICATE_ACTIONS }) @IsIn(DUPLICATE_ACTIONS) action!: DuplicateAction;
}

export class ConfirmImportDto {
  @ApiPropertyOptional({ type: [DuplicateDecisionDto], description: 'Solo para filas "posible duplicado"; por defecto SKIP' })
  @IsOptional() @IsArray() @ArrayMaxSize(IMPORT_LIMITS.MAX_DATA_ROWS) @ValidateNested({ each: true }) @Type(() => DuplicateDecisionDto)
  decisions?: DuplicateDecisionDto[];
}
