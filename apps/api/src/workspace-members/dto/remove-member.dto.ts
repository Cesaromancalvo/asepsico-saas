import { MemberRemovalReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';

/**
 * Baja de un miembro. `reassignToUserId`: profesional clínico activo que recibe sus procesos
 * activos o en pausa y sus citas futuras; sin él quedan pendientes ("decidir después") hasta
 * POST /workspace-members/:userId/reassign. `reason`: lista cerrada, sin texto libre.
 */
export class RemoveMemberDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  reassignToUserId?: string;

  @IsOptional()
  @IsEnum(MemberRemovalReason)
  reason?: MemberRemovalReason;
}

/** Reasignación posterior del trabajo pendiente de un miembro ya dado de baja. */
export class ReassignMemberWorkDto {
  @IsString()
  @Length(1, 64)
  toUserId!: string;
}
