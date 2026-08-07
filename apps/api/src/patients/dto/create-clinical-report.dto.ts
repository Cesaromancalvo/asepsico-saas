import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum ClinicalReportType { EVOLUTION='EVOLUTION', DISCHARGE='DISCHARGE', REFERRAL='REFERRAL', CERTIFICATE='CERTIFICATE', CUSTOM='CUSTOM' }
export enum ClinicalReportStatus { DRAFT='DRAFT', FINAL='FINAL', VOID='VOID' }

export class CreateClinicalReportDto {
  @IsString() @MaxLength(180) title!: string;
  @IsEnum(ClinicalReportType) type!: ClinicalReportType;
  @IsOptional() @IsEnum(ClinicalReportStatus) status?: ClinicalReportStatus;
  @IsString() @MaxLength(30000) content!: string;
}

export class UpdateClinicalReportDto {
  @IsOptional() @IsString() @MaxLength(180) title?: string;
  @IsOptional() @IsEnum(ClinicalReportType) type?: ClinicalReportType;
  @IsOptional() @IsEnum(ClinicalReportStatus) status?: ClinicalReportStatus;
  @IsOptional() @IsString() @MaxLength(30000) content?: string;
}
