import { Prisma, PrismaClient } from '@prisma/client';

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

/** --email x o --email=x */
export function emailArg(args: string[]): string | undefined {
  const index = args.indexOf('--email');
  return index >= 0 ? args[index + 1] : args.find((a) => a.startsWith('--email='))?.slice('--email='.length);
}

/** Los CLI que buscan por email necesitan el MISMO WAITLIST_SECRET que la API. */
export function assertEmailLookupConfig(args: string[], email: string | undefined): asserts email is string {
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
  if (!process.env.WAITLIST_SECRET && !args.includes('--allow-dev-secret')) {
    throw new Error('Falta WAITLIST_SECRET (el de la API). Solo en local puede usarse el de desarrollo con --allow-dev-secret.');
  }
  if (!email || !email.includes('@')) throw new Error('Indica el email con --email <email>');
}

/** Ejecuta un CLI con un PrismaClient y la gestión de errores sin datos personales. */
export function runWaitlistCli(name: string, body: (prisma: PrismaClient) => Promise<void>): void {
  const prisma = new PrismaClient();
  body(prisma)
    .catch((error) => {
      console.error(`${name} falló: ${describeScriptError(error)}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
