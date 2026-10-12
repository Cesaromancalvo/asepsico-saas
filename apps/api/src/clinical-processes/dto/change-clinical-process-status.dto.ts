import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

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

  /**
   * Al cerrar o dar de alta (CLOSED / DISCHARGED) un proceso con citas futuras programadas, la
   * API responde 409 PROCESS_HAS_FUTURE_SESSIONS salvo que se pida explícitamente cancelarlas:
   * con `true`, se cancelan en la misma transacción que el cambio de estado, con auditoría.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  cancelFutureSessions?: boolean;
}
