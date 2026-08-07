import { IsEnum, IsOptional, IsString, IsUrl, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { ResourceCategory, ResourceType } from '@prisma/client';

export class CreateResourceDto {
  @IsString() @MinLength(2) @MaxLength(180) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsEnum(ResourceType) type!: ResourceType;
  @IsEnum(ResourceCategory) category!: ResourceCategory;
  @ValidateIf((o) => o.type === ResourceType.LINK) @IsUrl({ require_protocol: true }) url?: string;
  @ValidateIf((o) => o.type === ResourceType.FILE) @IsString() @MinLength(1) @MaxLength(255) fileName?: string;
  @IsOptional() @IsString() @MaxLength(120) mimeType?: string;
  @IsOptional() @IsString() @MaxLength(500) storageKey?: string;
}

export class UpdateResourceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(180) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsEnum(ResourceCategory) category?: ResourceCategory;
  @IsOptional() @IsUrl({ require_protocol: true }) url?: string;
}
