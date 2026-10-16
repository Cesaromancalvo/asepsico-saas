import { BadRequestException } from '@nestjs/common';

/** Roles con los que se puede invitar a un miembro. Nunca OWNER (CHECK en la BD). */
export const INVITABLE_ROLES = ['ADMIN', 'THERAPIST', 'ASSISTANT'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/**
 * isClinician coherente con el rol (los CHECK de WorkspaceMember y WorkspaceInvite lo exigen):
 * THERAPIST siempre clínico, ASSISTANT nunca, ADMIN según se indique (por defecto no).
 * Una combinación contradictoria explícita es un error (400), no se corrige en silencio.
 */
export function clinicianFlagForRole(role: string, requested?: boolean): boolean {
  if (role === 'THERAPIST') {
    if (requested === false) throw new BadRequestException('Un terapeuta siempre es profesional clínico');
    return true;
  }
  if (role === 'ASSISTANT') {
    if (requested === true) throw new BadRequestException('Un asistente no puede ser profesional clínico');
    return false;
  }
  if (role === 'ADMIN') return requested === true;
  throw new BadRequestException('Rol no válido para una invitación');
}
