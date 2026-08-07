import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class CreateInvoiceLineDto {
  @IsString() @Length(1, 200) description!: string;
  @IsInt() @Min(1) @Max(1000) quantity!: number;
  @IsInt() @Min(0) @Max(100_000_000) unitPriceCents!: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) taxRateBps?: number;
}

export class CreateInvoiceDto {
  @IsString() patientId!: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CreateInvoiceLineDto)
  lines!: CreateInvoiceLineDto[];
}
