import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum PatientDocumentType {
  CLINICAL = 'CLINICAL',
  REFERRAL = 'REFERRAL',
  ADMINISTRATIVE = 'ADMINISTRATIVE',
  EXTERNAL_REPORT = 'EXTERNAL_REPORT',
  OTHER = 'OTHER',
}

export class CreatePatientDocumentDto {
  @IsString() @MaxLength(180) title!: string;
  @IsEnum(PatientDocumentType) type!: PatientDocumentType;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsString() @MaxLength(255) fileName?: string;
  @IsOptional() @IsString() @MaxLength(120) mimeType?: string;
  @IsOptional() @IsString() @MaxLength(500) storageKey?: string;
}
