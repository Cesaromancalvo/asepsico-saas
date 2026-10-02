/**
 * Interruptores de funcionalidad de la web. Todos APAGADOS por defecto.
 *
 * El alta libre (/register) queda oculta hasta que se integre el registro por invitación
 * (feat/registro-por-invitacion). Solo se activa con NEXT_PUBLIC_ENABLE_SELF_REGISTRATION=true.
 */
export const SELF_REGISTRATION_ENABLED = process.env.NEXT_PUBLIC_ENABLE_SELF_REGISTRATION === 'true';
