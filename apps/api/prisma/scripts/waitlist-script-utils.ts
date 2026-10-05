import { Prisma } from '@prisma/client';

/**
 * Nunca volcar el error de Prisma entero: sus mensajes pueden incluir los argumentos de la
 * consulta (es decir, datos personales). Solo código o tipo de error.
 */
export function describeScriptError(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `Prisma ${error.code}`;
  if (error instanceof Prisma.PrismaClientValidationError) return 'validación de Prisma (detalle omitido para no volcar datos)';
  if (error instanceof Prisma.PrismaClientInitializationError) return `no se pudo conectar a la base de datos (${error.errorCode ?? 'sin código'})`;
  if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EEXIST') return 'el archivo de salida ya existe (no se sobrescribe)';
  if (error instanceof Error && !error.constructor.name.startsWith('PrismaClient')) return error.message;
  return 'error desconocido';
}
