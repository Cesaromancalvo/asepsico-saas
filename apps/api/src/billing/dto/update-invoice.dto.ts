import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { CreateInvoiceLineDto } from './create-invoice.dto';

export class UpdateInvoiceDto {
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CreateInvoiceLineDto)
  lines?: CreateInvoiceLineDto[];
}

export class VoidInvoiceDto {
  @IsString() @MaxLength(500) reason!: string;
}
