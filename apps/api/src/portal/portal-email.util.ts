/**
 * Correo de una cuenta de portal: hoy NUNCA está verificado (no hay envío de email), ni en el
 * alta manual ni en el alta por QR (lo teclea el paciente o la consulta). Condición de Argos:
 * mientras emailVerifiedAt sea nulo, el correo no se usa para enviar notificaciones ni para
 * recuperar la contraseña. Todo envío futuro por email al paciente DEBE pasar por aquí.
 *
 * Correo "ocupado" por error (el email es único entre todas las cuentas de portal): solo lo libera
 * la consulta titular de esa cuenta. Primero la desactiva o rechaza (DELETE
 * /patients/:id/portal-account, o archivar/bloquear al paciente) y después OWNER/ADMIN llama a
 * POST /patients/:patientId/portal-accounts/:accountId/release-email, que sustituye el correo
 * por un marcador .invalid y audita PORTAL_ACCOUNT_EMAIL_RELEASED (sin el correo). Un correo
 * verificado no se libera así.
 */
export function portalEmailUsableForDelivery(account: { emailVerifiedAt?: Date | null; isActive?: boolean | null } | null | undefined): boolean {
  return Boolean(account?.isActive === true && account.emailVerifiedAt);
}

/** Marcador que sustituye a un correo liberado (dominio reservado .invalid, RFC 2606). */
export function releasedEmailPlaceholder(accountId: string): string {
  return `liberado-${accountId}@liberado.invalid`;
}
