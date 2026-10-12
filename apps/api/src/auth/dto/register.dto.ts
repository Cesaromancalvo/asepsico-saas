import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
export class RegisterDto {
  @ApiProperty() @IsString() @MinLength(2) firstName!: string;
  @ApiProperty() @IsString() @MinLength(2) lastName!: string;
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty() @IsString() @MinLength(12) password!: string;
  @ApiProperty() @IsString() @MinLength(2) workspaceName!: string;
  /** "¿Atiendes pacientes?" Por defecto false: el titular de la consulta no tiene por qué ser clínico. */
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isClinician?: boolean;
}
