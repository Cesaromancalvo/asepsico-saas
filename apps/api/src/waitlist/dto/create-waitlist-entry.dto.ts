import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WaitlistContactPreference, WaitlistSituation, WaitlistSource } from '@prisma/client';
import { Transform } from 'class-transformer';
import { Equals, IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS, RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS } from '../waitlist.config';
import { WAITLIST_PHONE_MAX_INPUT_LENGTH } from '../waitlist-phone';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Sin caracteres de control (C0, DEL y C1) salvo tabulador y saltos de línea (la v2 usaba un textarea). */
const NO_CONTROL_CHARS = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]*$/;

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

  /**
   * Preferencia de contacto: solo la ofrecía la lista-espera-v6, ya retirada. La v7 (vigente) no la
   * admite. Opcional para class-validator para que el servicio responda con su code propio
   * (WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED) y no con el 400 genérico. Un valor que no sea del enum
   * → 400 genérico.
   */
  @ApiPropertyOptional({ enum: WaitlistContactPreference, description: 'No admitida en lista-espera-v7 (vigente): si llega → 400 WAITLIST_CONTACT_PREFERENCE_NOT_OFFERED. Solo la usaba la v6, retirada.' })
  @IsOptional() @IsEnum(WaitlistContactPreference)
  contactPreference?: WaitlistContactPreference;

  /**
   * Teléfono tal como lo escribe la persona (la API lo valida y lo normaliza a E.164). Opcional para
   * class-validator: la regla la comprueba el servicio (codes propios para la landing). Nunca se
   * registra ni se devuelve en un error.
   */
  @ApiPropertyOptional({ maxLength: WAITLIST_PHONE_MAX_INPUT_LENGTH, example: '+34600000001', description: 'lista-espera-v7 (vigente): obligatorio. Se guarda cifrado en E.164.' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(WAITLIST_PHONE_MAX_INPUT_LENGTH)
  phone?: string;

  @ApiProperty({ enum: WaitlistSituation })
  @IsEnum(WaitlistSituation)
  situation!: WaitlistSituation;

  @ApiPropertyOptional({ maxLength: 500, description: 'Herramientas que usa hoy (texto libre, sin datos de pacientes)' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  @Matches(NO_CONTROL_CHARS, { message: 'tools contiene caracteres no permitidos' })
  tools?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 500 })
  @IsOptional() @IsInt() @Min(1) @Max(500)
  professionalsCount?: number;

  @ApiPropertyOptional({ enum: WaitlistSource, description: 'Opcional; NOT_SAID = "Prefiero no decirlo"' })
  @IsOptional() @IsEnum(WaitlistSource)
  source?: WaitlistSource;

  @ApiProperty({ description: 'Debe ser true: aceptación de la política de privacidad de la lista de espera' })
  @IsBoolean() @Equals(true, { message: 'privacyAccepted debe ser true' })
  privacyAccepted!: boolean;

  // Pasan el DTO la vigente (v7) y las retiradas (v1–v6): el servicio rechaza las retiradas con un
  // code propio (WAITLIST_POLICY_VERSION_RETIRED).
  // Cualquier otro valor → 400 de validación genérico.
  @ApiProperty({ enum: ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS })
  @IsString() @IsIn([...ACCEPTED_WAITLIST_PRIVACY_POLICY_VERSIONS, ...RETIRED_WAITLIST_PRIVACY_POLICY_VERSIONS], { message: 'privacyPolicyVersion no es una versión vigente' })
  privacyPolicyVersion!: string;

  @ApiPropertyOptional({ description: 'Casilla opcional de comunicaciones comerciales. Solo registra la solicitud: el consentimiento válido requiere doble opt-in por email' })
  @IsOptional() @IsBoolean()
  commercialConsentRequested?: boolean;

  @ApiProperty({ description: 'Token de GET /public/waitlist/form-token' })
  @IsString() @MaxLength(200)
  formToken!: string;

  @ApiPropertyOptional({ description: 'Honeypot: campo oculto que debe llegar vacío' })
  @IsOptional() @IsString() @MaxLength(500)
  website?: string;
}
