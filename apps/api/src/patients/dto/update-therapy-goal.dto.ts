import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreateTherapyGoalDto } from './create-therapy-goal.dto';

export const THERAPY_GOAL_STATUSES = ['ACTIVE', 'ACHIEVED', 'PAUSED', 'CANCELLED'] as const;
export type TherapyGoalStatusValue = (typeof THERAPY_GOAL_STATUSES)[number];

export class UpdateTherapyGoalDto extends PartialType(CreateTherapyGoalDto) {
  @ApiPropertyOptional({ enum: THERAPY_GOAL_STATUSES })
  @IsOptional()
  @IsIn(THERAPY_GOAL_STATUSES)
  status?: TherapyGoalStatusValue;
}
