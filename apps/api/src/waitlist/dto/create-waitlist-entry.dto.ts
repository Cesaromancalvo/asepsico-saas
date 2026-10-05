import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WaitlistSituation, WaitlistSource } from '@prisma/client';
import { Transform } from 'class-transformer';
import { Equals, IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS } from '../waitlist.config';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Alta pública en la lista de espera. La ValidationPipe global usa whitelist +
 * forbidNonWhitelisted: cualquier campo no declarado aquí es un 400. Los mensajes de error de
 * class-validator nombran el campo, nunca su valor.
 */
export class CreateWaitlistEntryDto {
  @ApiProperty({ maxLength: 120 })
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @ApiProperty({ maxLength: 254 })
  @Transform(trim) @IsString() @MaxLength(254) @IsEmail()
  email!: string;

  @ApiProperty({ enum: WaitlistSituation })
  @IsEnum(WaitlistSituation)
  situation!: WaitlistSituation;

  @ApiPropertyOptional({ maxLength: 500, description: 'Herramientas que usa hoy (texto libre, sin datos de pacientes)' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  tools?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 500 })
  @IsOptional() @IsInt() @Min(1) @Max(500)
  professionalsCount?: number;

  @ApiProperty({ enum: WaitlistSource })
  @IsEnum(WaitlistSource)
  source!: WaitlistSource;

  @ApiProperty({ description: 'Debe ser true: aceptación de la política de privacidad de la lista de espera' })
  @IsBoolean() @Equals(true, { message: 'privacyAccepted debe ser true' })
  privacyAccepted!: boolean;

  @ApiProperty({ enum: ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS })
  @IsString() @IsIn([...ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS], { message: 'privacyPolicyVersion no es una versión vigente' })
  privacyPolicyVersion!: string;

  @ApiPropertyOptional({ description: 'Casilla opcional de comunicaciones comerciales' })
  @IsOptional() @IsBoolean()
  commercialConsent?: boolean;

  @ApiProperty({ description: 'Token de GET /public/waitlist/form-token' })
  @IsString() @MaxLength(200)
  formToken!: string;

  @ApiPropertyOptional({ description: 'Honeypot: campo oculto que debe llegar vacío' })
  @IsOptional() @IsString() @MaxLength(500)
  website?: string;
}
