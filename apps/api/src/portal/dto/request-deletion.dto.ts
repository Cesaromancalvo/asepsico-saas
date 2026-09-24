import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestDeletionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
