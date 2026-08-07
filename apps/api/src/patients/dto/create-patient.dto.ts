import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IsPlausibleBirthDate } from '../../common/validators/plausible-birth-date.validator';

// Formato de teléfono permisivo (nacional o internacional): dígitos, espacios, +, -, paréntesis.
const PHONE_REGEX = /^[+()\d][\d\s()-]{5,19}$/;

export class CreatePatientDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) firstName!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) lastName!: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(160) email?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(PHONE_REGEX, { message: 'phone tiene un formato no válido' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsPlausibleBirthDate() birthDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) consultationReason?: string;
}
