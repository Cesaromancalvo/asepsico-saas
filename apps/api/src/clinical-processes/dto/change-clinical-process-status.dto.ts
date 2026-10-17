import { PROCESS_OPENING_REASONS, ProcessOpeningReasonCode } from '../../exceptional-access/exceptional-access.policy';
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

  /**
   * H6: obligatorio solo si el paciente tiene historia con otro profesional (si no, se ignora).
   * Sin él, la API responde 400 OPENING_REASON_REQUIRED y la web muestra el selector. Solo
   * OWNER/ADMIN pueden abrir o reactivar sobre historia ajena (THERAPIST: 403).
   */
  @ApiPropertyOptional({ enum: PROCESS_OPENING_REASONS })
  @IsOptional()
  @IsIn(PROCESS_OPENING_REASONS)
  openingReasonCode?: ProcessOpeningReasonCode;
}
