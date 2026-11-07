import { portalEmailUsableForDelivery } from '../../portal/portal-email.util';
import { isReservedEmailDomain } from './recipient-deliverability';

/**
 * Argos M2 (07/11/2026): el destinatario de un email del grupo PATIENT SOLO puede salir de aquí, y
 * aquí solo sale el correo de una cuenta de portal ACTIVA con el correo VERIFICADO
 * (portalEmailUsableForDelivery) y de un dominio no reservado (Dora R1). Nunca Patient.email de la ficha ni un correo sin verificar.
 * Un test estático (no-email-sending) impide leer el email del paciente en otro sitio de la bandeja.
 */
export function patientRecipientEmail(account: { email?: string | null; isActive?: boolean | null; emailVerifiedAt?: Date | null } | null | undefined): string | null {
  if (!account || !portalEmailUsableForDelivery(account)) return null;
  const email = (account.email ?? '').trim();
  return email && !isReservedEmailDomain(email) ? email : null;
}
