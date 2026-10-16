import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { EXCEPTIONAL_ACCESS_REASONS, ExceptionalAccessReasonCode } from '../exceptional-access.policy';

export const JUSTIFICATION_MIN = 20;
export const JUSTIFICATION_MAX = 300;

/** POST /patients/:patientId/exceptional-access (H1). Sin "Otro": catálogo cerrado de 7. */
export class CreateExceptionalAccessDto {
  @ApiProperty({ enum: EXCEPTIONAL_ACCESS_REASONS })
  @IsIn(EXCEPTIONAL_ACCESS_REASONS)
  reasonCode!: ExceptionalAccessReasonCode;

  /** Porqué ADMINISTRATIVO (nunca clínico). El paciente puede leerlo. Se guarda cifrado. */
  @ApiProperty({ minLength: JUSTIFICATION_MIN, maxLength: JUSTIFICATION_MAX })
  @IsString()
  @MinLength(JUSTIFICATION_MIN)
  @MaxLength(JUSTIFICATION_MAX)
  justification!: string;

  /** Casilla de confirmación (art. 16.6 Ley 41/2002): debe venir a true. */
  @ApiProperty({ enum: [true] })
  @Equals(true)
  confirmed!: true;

  /** El usuario vio el aviso de términos clínicos y decidió continuar (CA1.7). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  clinicalTermWarningAcknowledged?: boolean;

  /** Diferir el aviso al titular (solo OWNER y solo LEGAL_REQUIREMENT, CLAIM_DEFENCE, DATA_INCIDENT). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  deferNotice?: boolean;

  @ApiPropertyOptional({ minLength: JUSTIFICATION_MIN, maxLength: JUSTIFICATION_MAX })
  @IsOptional()
  @IsString()
  @MinLength(JUSTIFICATION_MIN)
  @MaxLength(JUSTIFICATION_MAX)
  deferReason?: string;
}

export const JUSTIFICATION_READ_PURPOSES = ['URGENCY_REVIEW', 'PATIENT_REQUEST', 'CLAIM_OR_AUTHORITY', 'INTERNAL_AUDIT'] as const;
export type JustificationReadPurposeValue = (typeof JUSTIFICATION_READ_PURPOSES)[number];
/** Paciente bloqueado: la explicación solo se lee por estos motivos (CA4.6). */
export const BLOCKED_READ_PURPOSES: readonly JustificationReadPurposeValue[] = ['PATIENT_REQUEST', 'CLAIM_OR_AUTHORITY'];

/** POST /exceptional-access/:id/justification (solo OWNER, CA4.2). */
export class ReadJustificationDto {
  @ApiProperty({ enum: JUSTIFICATION_READ_PURPOSES })
  @IsIn(JUSTIFICATION_READ_PURPOSES)
  purpose!: JustificationReadPurposeValue;
}

export const REVIEW_OUTCOMES = ['CORRECT', 'INCIDENT'] as const;

/** POST /exceptional-access/:id/review y /exceptional-access/openings/:id/review (solo OWNER). */
export class ReviewDto {
  @ApiProperty({ enum: REVIEW_OUTCOMES })
  @IsIn(REVIEW_OUTCOMES)
  outcome!: (typeof REVIEW_OUTCOMES)[number];
}
