import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  attachmentName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  attachmentKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  mimeType?: string;
}

export class UpdateConversationDto {
  @IsOptional()
  @IsIn(['OPEN', 'CLOSED', 'ARCHIVED'])
  status?: 'OPEN' | 'CLOSED' | 'ARCHIVED';

  @IsOptional()
  @IsBoolean()
  patientCanReply?: boolean;
}
