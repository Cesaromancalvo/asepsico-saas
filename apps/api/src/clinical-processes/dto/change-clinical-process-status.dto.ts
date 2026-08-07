import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const CLINICAL_PROCESS_STATUSES = [
  'ACTIVE',
  'PAUSED',
  'DISCHARGED',
  'CLOSED',
] as const;

export type ClinicalProcessStatusValue =
  (typeof CLINICAL_PROCESS_STATUSES)[number];

export class ChangeClinicalProcessStatusDto {
  @ApiProperty({ enum: CLINICAL_PROCESS_STATUSES })
  @IsIn(CLINICAL_PROCESS_STATUSES)
  status!: ClinicalProcessStatusValue;
}
