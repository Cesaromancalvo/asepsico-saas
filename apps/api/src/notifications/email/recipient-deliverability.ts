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

/**
 * Argos C1 (08/11/2026) · Excepción SOLO para tests. Los tests con BD y los unitarios usan correos de
 * un dominio reservado (p. ej. @destinatario.test), que nunca puede entregarse aunque la bandeja de
 * salida y un proveedor de correo estuvieran encendidos contra esa base. Para poder probar el camino «sí se envía» con
 * transporte falso, un test puede permitir de forma EXPLÍCITA dominios reservados concretos (coincidencia
 * exacta, sin subdominios).
 *
 * No hay variable de entorno: solo se activa llamando a esta función, que lanza un error fuera de Jest
 * (NODE_ENV=test y JEST_WORKER_ID). Además, la excepción se vuelve a comprobar en cada uso, así que
 * aunque el estado quedara activado, fuera de Jest no tiene efecto. Un test estático
 * (email-recipient-deliverability) impide que ningún archivo de src la llame.
 * Nunca relaja isDemo ni los correos sin dominio: solo dominios reservados listados.
 */
let reservedDomainsAllowedInTests: ReadonlySet<string> = new Set();

function runningUnderJest(): boolean {
  return process.env.NODE_ENV === 'test' && !!process.env.JEST_WORKER_ID;
}

export function allowReservedRecipientDomainsInTests(domains: readonly string[]): void {
  if (!runningUnderJest()) throw new Error('allowReservedRecipientDomainsInTests solo puede usarse en tests (Jest con NODE_ENV=test)');
  const normalized = domains.map((d) => String(d).trim().toLowerCase());
  for (const d of normalized) {
    if (!d || !isReservedEmailDomain(`x@${d}`)) throw new Error('Solo se pueden permitir en tests dominios reservados (RFC 2606 / 6761)');
  }
  reservedDomainsAllowedInTests = new Set(normalized);
}

/**
 * true si NUNCA se envía a esta dirección: dominio reservado o sin dominio. La única excepción son los
 * dominios reservados que un test haya permitido explícitamente, y solo mientras se ejecuta en Jest.
 */
export function isBlockedRecipientEmail(email: string | null | undefined): boolean {
  if (!isReservedEmailDomain(email)) return false;
  if (!reservedDomainsAllowedInTests.size || !runningUnderJest()) return true;
  const domain = domainOf(String(email ?? '').trim());
  return !domain || !reservedDomainsAllowedInTests.has(domain);
}

/** Un usuario del equipo puede recibir avisos por email: no es demo y su correo no es reservado. */
export function isDeliverableStaffUser(user: { email?: string | null; isDemo?: boolean | null } | null | undefined): boolean {
  if (!user || user.isDemo !== false) return false;
  return !!user.email && !isBlockedRecipientEmail(user.email);
}
