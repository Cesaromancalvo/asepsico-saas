import { ForbiddenException } from '@nestjs/common';
import { AuthUser } from '../decorators/current-user.decorator';

export const STAFF_ROLES = ['OWNER', 'ADMIN', 'THERAPIST', 'ASSISTANT'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * Lista blanca, no lista negra: si en algún punto un `actor.role` llega vacío, indefinido o
 * con un valor inesperado (por ejemplo, por confundir un token de otro dominio de confianza
 * con uno de staff), esto debe bloquear el acceso, no concederlo por omisión. El código de
 * negocio NUNCA debe escribir "restringe solo si el rol es X"; siempre "permite solo si el
 * rol es uno de estos".
 */
export function assertStaffRole(actor: Pick<AuthUser, 'role'>): asserts actor is AuthUser & { role: StaffRole } {
  if (!STAFF_ROLES.includes(actor?.role as StaffRole)) {
    throw new ForbiddenException('No autorizado');
  }
}
