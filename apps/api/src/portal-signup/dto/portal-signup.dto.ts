import { ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsDateString, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { IsPlausibleBirthDate } from '../../common/validators/plausible-birth-date.validator';
import { PORTAL_SIGNUP_NOTICE_VERSIONS } from '../portal-signup.config';

const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;
const NAME_RULE = /^[\p{L}\p{M} .'’-]+$/u;

/** Solicitud pública desde el QR fijo del profesional. Nada aquí identifica al profesional salvo el token. */
export class SubmitSignupRequestDto {
  @IsString() @Length(43, 43) @Matches(/^[A-Za-z0-9_-]+$/)
  token!: string;

  @IsString() @Length(1, 80) @Matches(NAME_RULE, { message: 'Nombre no válido' })
  firstName!: string;

  @IsString() @Length(1, 120) @Matches(NAME_RULE, { message: 'Apellidos no válidos' })
  lastName!: string;

  @IsEmail() @MaxLength(254)
  email!: string;

  @IsOptional() @IsString() @Matches(/^\+?[0-9 ]{6,20}$/, { message: 'Teléfono no válido' })
  phone?: string;

  // Obligatoria (C6): sin fecha de nacimiento no hay alta por QR. Solo la fecha, sin hora.
  @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsPlausibleBirthDate()
  birthDate!: string;

  /** Acuse de lectura de la información art. 13 (no es consentimiento). Debe venir marcado. */
  @Equals(true)
  privacyNoticeAcknowledged!: true;

  /** Aceptación de las normas de uso del portal. Debe venir marcada. */
  @Equals(true)
  portalTermsAccepted!: true;

  @IsIn([PORTAL_SIGNUP_NOTICE_VERSIONS.privacyNotice])
  privacyNoticeVersion!: string;

  @IsIn([PORTAL_SIGNUP_NOTICE_VERSIONS.portalTerms])
  portalTermsVersion!: string;
}

export const LINK_WARNINGS = ['EMAIL_MISMATCH', 'PHONE_MISMATCH', 'PORTAL_PREVIOUSLY_DISABLED'] as const;
export type LinkWarning = (typeof LINK_WARNINGS)[number];

/** Vincular la solicitud a un paciente que ya existe (mismo workspace). */
export class LinkSignupRequestDto {
  @IsString() @Length(1, 64)
  patientId!: string;

  /** Avisos que la consulta confirma tras comprobar la identidad en persona (los devuelve el 409). */
  @IsOptional() @IsArray() @ArrayMaxSize(LINK_WARNINGS.length) @IsIn([...LINK_WARNINGS], { each: true })
  confirmWarnings?: LinkWarning[];
}

/** Rechazo masivo de solicitudes pendientes. */
export class BulkRejectSignupRequestsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @Length(1, 64, { each: true })
  requestIds!: string[];
}

/** Activación pública: el paciente elige su contraseña (misma política que el cambio de contraseña). */
export class ActivatePortalAccountDto {
  @IsString() @Length(43, 43) @Matches(/^[A-Za-z0-9_-]+$/)
  token!: string;

  @IsString() @Length(12, 128)
  @Matches(PASSWORD_RULE, { message: 'La contraseña debe incluir mayúscula, minúscula y número' })
  password!: string;
}
