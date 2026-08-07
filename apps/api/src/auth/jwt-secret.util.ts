export function getJwtSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET es obligatorio en producción');
  }
  return 'development-only-secret-change-me';
}
