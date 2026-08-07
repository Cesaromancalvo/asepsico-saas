export function getPortalJwtSecret(): string {
  const configured = process.env.PORTAL_JWT_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PORTAL_JWT_SECRET es obligatorio en producción');
  }
  return 'development-only-portal-secret-change-me';
}
