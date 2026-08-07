import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

// Solo se puede cerrar una sesión programada; el resultado es terminal (no hay vuelta atrás,
// se crea una nueva sesión si hace falta reprogramar tras un NO_SHOW o CANCELLED).
export const CLOSING_STATUSES = ['COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;
export type ClosingStatus = (typeof CLOSING_STATUSES)[number];

export class CloseSessionDto {
  @ApiProperty({ enum: CLOSING_STATUSES })
  @IsIn(CLOSING_STATUSES)
  status!: ClosingStatus;
}
