import { IsString, MinLength } from 'class-validator';

export class ConfirmPasswordDto {
  @IsString()
  @MinLength(1)
  password!: string;
}
