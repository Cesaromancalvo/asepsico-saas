import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @IsOptional() @IsBoolean() appointmentReminders?: boolean;
  @IsOptional() @IsBoolean() taskReminders?: boolean;
  @IsOptional() @IsBoolean() consentReminders?: boolean;
  @IsOptional() @IsBoolean() invoiceReminders?: boolean;
  @IsOptional() @IsBoolean() emailEnabled?: boolean;
  @IsOptional() @IsBoolean() smsEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(168) reminderHoursBefore?: number;
}
