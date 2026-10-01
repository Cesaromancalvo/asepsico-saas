import { IsBoolean } from 'class-validator';

export class UpdateMemberClinicianDto {
  @IsBoolean()
  isClinician!: boolean;
}
