import { IsEmail, IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';

export class PortalLoginDto {
  @IsEmail() email!: string;
  @IsString() @Length(10, 128) password!: string;
}

export class EnablePortalDto {
  @IsEmail() email!: string;
  @IsString() @Length(12, 128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, { message: 'La contraseña debe incluir mayúscula, minúscula y número' })
  temporaryPassword!: string;

  // Quién es esta cuenta: el propio paciente, o uno de sus tutores. Por defecto PATIENT,
  // para no romper el uso actual (activar el portal del propio paciente) si no se indica.
  @IsOptional()
  @IsEnum(['PATIENT', 'GUARDIAN'])
  accessorType?: 'PATIENT' | 'GUARDIAN';

  // Solo tienen sentido cuando accessorType es GUARDIAN.
  @IsOptional()
  @IsString()
  guardianName?: string;

  @IsOptional()
  @IsString()
  guardianRelationship?: string;
}

export class ChangePortalPasswordDto {
  @IsString() @Length(10, 128) currentPassword!: string;
  @IsString() @Length(12, 128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/)
  newPassword!: string;
}
