import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum ConsentType {
  DATA_PROCESSING = 'DATA_PROCESSING',
  INFORMED_CONSENT = 'INFORMED_CONSENT',
  TELEPSYCHOLOGY = 'TELEPSYCHOLOGY',
  MINOR_GUARDIAN = 'MINOR_GUARDIAN',
  COMMUNICATIONS = 'COMMUNICATIONS',
  OTHER = 'OTHER',
}
export enum ConsentStatus { PENDING='PENDING', SIGNED='SIGNED', REVOKED='REVOKED', EXPIRED='EXPIRED' }

export class CreateConsentRecordDto {
  @IsEnum(ConsentType) type!: ConsentType;
  @IsOptional() @IsString() @MaxLength(180) title?: string;
  @IsEnum(ConsentStatus) status!: ConsentStatus;
  @IsOptional() @IsDateString() signedAt?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
  @IsOptional() @IsString() @MaxLength(180) signedBy?: string;
  @IsOptional() @IsString() @MaxLength(3000) notes?: string;
}

export class UpdateConsentRecordDto {
  @IsOptional() @IsString() @MaxLength(180) title?: string;
  @IsOptional() @IsEnum(ConsentStatus) status?: ConsentStatus;
  @IsOptional() @IsDateString() signedAt?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
  @IsOptional() @IsString() @MaxLength(180) signedBy?: string;
  @IsOptional() @IsString() @MaxLength(3000) notes?: string;
}
