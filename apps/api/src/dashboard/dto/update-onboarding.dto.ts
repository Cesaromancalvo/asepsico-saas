import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateOnboardingDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  step?: number;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @IsOptional()
  @IsBoolean()
  dismissed?: boolean;
}
