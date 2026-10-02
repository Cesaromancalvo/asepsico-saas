import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, MaxLength } from 'class-validator';
import { INVITABLE_ROLES, InvitableRole } from '../member-role.util';

export class CreateMemberInviteDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  /** Nunca OWNER. */
  @ApiProperty({ enum: INVITABLE_ROLES }) @IsIn(INVITABLE_ROLES as unknown as string[]) role!: InvitableRole;
  /** THERAPIST → true (obligatorio), ASSISTANT → false (obligatorio), ADMIN → opcional (por defecto false). */
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isClinician?: boolean;
}
