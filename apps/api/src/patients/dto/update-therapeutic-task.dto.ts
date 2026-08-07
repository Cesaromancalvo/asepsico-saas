import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const THERAPEUTIC_TASK_STATUSES = ['DRAFT','PENDING','IN_PROGRESS','SUBMITTED','CHANGES_REQUESTED','COMPLETED','CANCELLED'] as const;
export type TherapeuticTaskStatusValue = (typeof THERAPEUTIC_TASK_STATUSES)[number];

export class UpdateTherapeuticTaskDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(180) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) instructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueDate?: string | null;
  @ApiPropertyOptional({ enum: THERAPEUTIC_TASK_STATUSES }) @IsOptional() @IsIn(THERAPEUTIC_TASK_STATUSES) status?: TherapeuticTaskStatusValue;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) clinicianNotes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) reviewComment?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) therapyGoalId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) sessionId?: string | null;
}
