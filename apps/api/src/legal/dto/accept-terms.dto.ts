import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { LegalDocumentType } from '@prisma/client';

/** Documento aceptado tal como lo sirvió GET /legal/terms (tipo, versión y hash del texto). */
export class AcceptedTermDto {
  @ApiProperty({ enum: LegalDocumentType }) @IsEnum(LegalDocumentType) documentType!: LegalDocumentType;
  @ApiProperty() @IsString() @MaxLength(50) version!: string;
  @ApiProperty() @IsString() @Matches(/^[a-f0-9]{64}$/) textHash!: string;
}

export class AcceptTermsDto {
  @ApiProperty({ type: [AcceptedTermDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AcceptedTermDto)
  acceptedTerms!: AcceptedTermDto[];
}
