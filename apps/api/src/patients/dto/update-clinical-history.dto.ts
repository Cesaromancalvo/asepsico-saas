import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateClinicalHistoryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) reasonForConsultation?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10000) currentProblem?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10000) personalHistory?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10000) familyHistory?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10000) medicalHistory?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) currentMedication?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) primaryDiagnosis?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10000) riskFactors?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10000) protectiveFactors?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(15000) clinicalObservations?: string;
}
