import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { MaxUtf8Bytes, MinChars, STAFF_PASSWORD_MAX_BYTES, STAFF_PASSWORD_MIN_LENGTH } from '../password-policy';

/** POST /auth/change-password. Nunca se registra ni se devuelve ninguno de estos campos. */
export class ChangePasswordDto {
  /** Sin requisitos de forma (puede venir de antes de la política actual); tope para no hashear textos enormes. */
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) currentPassword!: string;

  @ApiProperty({ minLength: STAFF_PASSWORD_MIN_LENGTH, description: `Máximo ${STAFF_PASSWORD_MAX_BYTES} bytes UTF-8` })
  @IsString()
  @MinChars(STAFF_PASSWORD_MIN_LENGTH, { message: `La nueva contraseña debe tener al menos ${STAFF_PASSWORD_MIN_LENGTH} caracteres` })
  @MaxUtf8Bytes(STAFF_PASSWORD_MAX_BYTES, { message: `La nueva contraseña no puede ocupar más de ${STAFF_PASSWORD_MAX_BYTES} bytes (unos ${STAFF_PASSWORD_MAX_BYTES} caracteres sin tildes)` })
  newPassword!: string;

  /** Código TOTP de 6 dígitos. Obligatorio solo si la cuenta tiene el MFA activo. */
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos' }) mfaCode?: string;
}
