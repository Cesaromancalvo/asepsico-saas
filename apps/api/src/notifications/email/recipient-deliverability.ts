/**
 * Dora R1 (07/11/2026) · Destinatarios a los que NUNCA se envía un aviso por email.
 *
 * Los espacios demo tienen recepción y terapeuta inventados (User.isDemo) con correos de dominios
 * reservados; un envío a ellos rebota y daña la reputación del remitente (el mismo que el aviso de la
 * lista de espera). Se excluyen al encolar y se vuelve a comprobar al enviar; la entrega se cancela
 * con RECIPIENT_NOT_DELIVERABLE. Nunca se registra la dirección.
 *
 * Dominios reservados (RFC 2606 y RFC 6761): los TLD .test, .example, .invalid y .localhost (y
 * cualquier subdominio suyo) y los dominios example.com, example.net y example.org (y sus
 * subdominios).
 */
export const RECIPIENT_NOT_DELIVERABLE = 'RECIPIENT_NOT_DELIVERABLE';

const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'] as const;
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'] as const;

/** Dominio (en minúsculas, sin punto final) de una dirección, o null si no tiene forma de correo. */
function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '');
  return domain || null;
}

/** true si la dirección es de un dominio reservado (o no tiene dominio): nunca se le envía. */
export function isReservedEmailDomain(email: string | null | undefined): boolean {
  const domain = domainOf(String(email ?? '').trim());
  if (!domain) return true;
  const labels = domain.split('.');
  if ((RESERVED_TLDS as readonly string[]).includes(labels[labels.length - 1])) return true;
  return RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Un usuario del equipo puede recibir avisos por email: no es demo y su correo no es reservado. */
export function isDeliverableStaffUser(user: { email?: string | null; isDemo?: boolean | null } | null | undefined): boolean {
  if (!user || user.isDemo !== false) return false;
  return !!user.email && !isReservedEmailDomain(user.email);
}
