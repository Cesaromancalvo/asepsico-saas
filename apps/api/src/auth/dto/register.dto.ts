import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { AcceptedTermDto } from '../../legal/dto/accept-terms.dto';

/**
 * Registro de un workspace nuevo: SOLO con invitación (registro cerrado). `inviteToken` y
 * `acceptedTerms` son opcionales en la validación para que su ausencia reciba la misma respuesta
 * neutra / el mismo código que un valor incorrecto (lo decide RegistrationService).
 */
export class RegisterDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(100) firstName!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(100) lastName!: string;
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @MinLength(12) @MaxLength(200) password!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(150) workspaceName!: string;
  /** "¿Atiendes pacientes?" Por defecto false: el titular de la consulta no tiene por qué ser clínico. */
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isClinician?: boolean;
  /** Token de la invitación (fragmento #invite= del enlace). */
  @ApiProperty() @IsOptional() @IsString() @MaxLength(200) inviteToken?: string;
  /** Versiones vigentes aceptadas, tal como las sirve GET /legal/terms. */
  @ApiProperty({ type: [AcceptedTermDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AcceptedTermDto)
  acceptedTerms?: AcceptedTermDto[];
}

/**
 * Alta de un miembro invitado a un workspace existente. Rol e isClinician los fija la invitación.
 * El miembro también acepta las condiciones vigentes (decisión del Jefe para el piloto demo).
 */
export class RegisterMemberDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(100) firstName!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(100) lastName!: string;
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @MinLength(12) @MaxLength(200) password!: string;
  @ApiProperty() @IsOptional() @IsString() @MaxLength(200) inviteToken?: string;
  /** Versiones vigentes aceptadas, tal como las sirve GET /legal/terms. */
  @ApiProperty({ type: [AcceptedTermDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AcceptedTermDto)
  acceptedTerms?: AcceptedTermDto[];
}
