/** Código o nombre del error, nunca su mensaje (puede incluir valores de la fila). */
export function errorKind(error: unknown): string {
  return (error as { code?: string })?.code ?? (error as Error)?.name ?? 'Error';
}

// Errores de Prisma causados por los DATOS de una fila (valor demasiado largo, tipo o carácter
// no válido, argumento rechazado por el motor…). Todo lo demás (conexión, timeout, conflictos
// de transacción, errores de programación) se trata como fallo de sistema → PARTIAL.
const ROW_DATA_ERROR_CODES = new Set(['P2000', 'P2005', 'P2006', 'P2007', 'P2009', 'P2011', 'P2012', 'P2019', 'P2020', 'P2023']);

export function isRowDataError(error: unknown): boolean {
  const name = (error as Error)?.name;
  if (name === 'PrismaClientValidationError' || name === 'PrismaClientUnknownRequestError') return true;
  const code = (error as { code?: string })?.code;
  return name === 'PrismaClientKnownRequestError' && code !== undefined && ROW_DATA_ERROR_CODES.has(code);
}
