import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { INVOICE_LINE_CONCEPTS } from '../invoice-concepts';

// Los importes viven en columnas Int de PostgreSQL (máx. ~2.147.483.647). Los topes de
// aquí abajo están pensados para que ni una sola línea, ni la suma de todas, puedan
// acercarse a ese límite y provocar un error de base de datos en vez de un 400 controlado.
export class CreateInvoiceLineDto {
  // Lista cerrada: el concepto lo ve recepción y nunca debe llevar texto clínico (condición de Argos).
  @IsIn(INVOICE_LINE_CONCEPTS, { message: 'El concepto debe ser uno de la lista (sin datos clínicos)' }) description!: string;
  @IsInt() @Min(1) @Max(1000) quantity!: number;
  @IsInt() @Min(0) @Max(2_000_000) unitPriceCents!: number; // hasta 20.000 € por unidad
  @IsOptional() @IsInt() @Min(0) @Max(10_000) taxRateBps?: number;
}
export class CreateInvoiceDto {
  @IsString() patientId!: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CreateInvoiceLineDto)
  lines!: CreateInvoiceLineDto[];
}
