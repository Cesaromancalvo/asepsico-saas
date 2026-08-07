import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateTherapyGoalDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(180) title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(3000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() targetDate?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 3, default: 2 }) @IsOptional() @IsInt() @Min(1) @Max(3) priority?: number;
}
