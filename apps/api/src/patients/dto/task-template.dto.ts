import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
export class CreateTaskTemplateDto {
 @IsString() @MinLength(2) @MaxLength(180) title!: string;
 @IsOptional() @IsString() @MaxLength(5000) instructions?: string;
 @IsOptional() @IsString() @MaxLength(80) category?: string;
}
export class UpdateTaskTemplateDto {
 @IsOptional() @IsString() @MinLength(2) @MaxLength(180) title?: string;
 @IsOptional() @IsString() @MaxLength(5000) instructions?: string;
 @IsOptional() @IsString() @MaxLength(80) category?: string;
 @IsOptional() @IsBoolean() isActive?: boolean;
}
