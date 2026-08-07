import { IsArray, IsIn, IsISO8601, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateClinicalAssessmentDto {
  @IsString()
  @IsIn(['PHQ9', 'GAD7', 'WHO5'])
  scaleCode!: 'PHQ9' | 'GAD7' | 'WHO5';

  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(5, { each: true })
  answers!: number[];

  @IsOptional()
  @IsISO8601()
  administeredAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  clinicalNotes?: string;
}
