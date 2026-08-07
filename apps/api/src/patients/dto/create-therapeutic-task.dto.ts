import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTherapeuticTaskDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(180) title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) instructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) therapyGoalId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) sessionId?: string;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() saveAsDraft?: boolean;
}
