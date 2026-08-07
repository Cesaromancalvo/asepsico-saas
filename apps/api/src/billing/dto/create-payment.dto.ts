import { IsDateString, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreatePaymentDto {
  @IsString() invoiceId!: string;
  @IsInt() @Min(1) amountCents!: number;
  @IsIn(['CASH','CARD','BANK_TRANSFER','BIZUM','DIRECT_DEBIT','OTHER']) method!: string;
  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ReversePaymentDto {
  @IsString() @MaxLength(500) reason!: string;
}
