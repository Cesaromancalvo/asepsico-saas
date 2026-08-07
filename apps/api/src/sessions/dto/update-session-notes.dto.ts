import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateSessionNotesDto {
  @ApiPropertyOptional({
    description: 'Notas clínicas de la sesión',
    maxLength: 10000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Resumen interno de la sesión',
    maxLength: 3000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  internalSummary?: string;
}
