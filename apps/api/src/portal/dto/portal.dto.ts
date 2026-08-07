import { IsEmail, IsString, Length, Matches } from 'class-validator';

export class PortalLoginDto {
  @IsEmail() email!: string;
  @IsString() @Length(10, 128) password!: string;
}

export class EnablePortalDto {
  @IsEmail() email!: string;
  @IsString() @Length(12, 128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, { message: 'La contraseña debe incluir mayúscula, minúscula y número' })
  temporaryPassword!: string;
}

export class ChangePortalPasswordDto {
  @IsString() @Length(10, 128) currentPassword!: string;
  @IsString() @Length(12, 128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/)
  newPassword!: string;
}
