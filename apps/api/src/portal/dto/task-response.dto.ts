import { IsString, MaxLength } from 'class-validator';
export class SaveTaskProgressDto { @IsString() @MaxLength(5000) patientFeedback!: string; }
