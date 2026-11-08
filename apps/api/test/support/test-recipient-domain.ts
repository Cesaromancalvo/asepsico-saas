import { allowReservedRecipientDomainsInTests } from '../../src/notifications/email/recipient-deliverability';

/**
 * Argos C1 (08/11/2026) · Dominio de los correos ficticios de los tests (unitarios y con BD).
 * Es un dominio RESERVADO (.test, RFC 6761): nunca puede entregarse, aunque alguien ejecutara los
 * tests con BD contra una base con el worker de email y un SMTP encendidos.
 *
 * El filtro de Dora R1 lo bloquea por defecto. Los tests que necesitan el camino «sí se envía» (con
 * transporte falso) lo permiten explícitamente con allowTestRecipientDomain(), que solo funciona
 * dentro de Jest. Los demás dominios reservados (example.test, example.com, .invalid…) siguen
 * bloqueados, así que los tests de R1 siguen comprobando el bloqueo.
 */
export const TEST_RECIPIENT_DOMAIN = 'destinatario.test';

/** Permite solo TEST_RECIPIENT_DOMAIN (coincidencia exacta) mientras dure el bloque de tests. */
export function allowTestRecipientDomain(): void {
  beforeAll(() => allowReservedRecipientDomainsInTests([TEST_RECIPIENT_DOMAIN]));
  afterAll(() => allowReservedRecipientDomainsInTests([]));
}
