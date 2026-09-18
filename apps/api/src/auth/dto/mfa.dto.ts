import { IsString, Length, MinLength } from 'class-validator';

export class VerifyMfaLoginDto {
  @IsString()
  pendingToken!: string;

  @IsString()
  @Length(6, 11) // 6 dígitos TOTP, u 11 caracteres de un código de recuperación (XXXXX-XXXXX)
  code!: string;
}

export class ConfirmMfaSetupDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class DisableMfaDto {
  @IsString()
  @MinLength(1)
  password!: string;

  @IsString()
  @Length(6, 11)
  code!: string;
}
