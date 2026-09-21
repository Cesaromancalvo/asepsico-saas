import { IsString, MinLength } from 'class-validator';

export class LogExceptionalAccessDto {
  @IsString()
  @MinLength(10, { message: 'Explica el motivo con algo más de detalle (mínimo 10 caracteres)' })
  reason!: string;
}
