import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

// ARCHIVED se gestiona con los endpoints dedicados /archive y /restore, porque además
// del estado implica soft-delete (deletedAt). Aquí solo se permiten transiciones clínicas.
export const ASSIGNABLE_STATUSES = ['ACTIVE', 'PAUSED', 'DISCHARGED'] as const;
export type AssignableStatus = (typeof ASSIGNABLE_STATUSES)[number];

export class ChangeStatusDto {
  @ApiProperty({ enum: ASSIGNABLE_STATUSES })
  @IsIn(ASSIGNABLE_STATUSES)
  status!: AssignableStatus;
}
