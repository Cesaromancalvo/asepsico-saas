import { Logger } from '@nestjs/common';

type Db = any;

const logger = new Logger('StaffEmailBestEffort');

/**
 * Incidente 11/11/2026 · Un fallo al preparar o encolar emails al equipo NUNCA debe tumbar la
 * operación que los dispara (solicitud del portal, cambio de cita...). Se ejecuta `fn` dentro de un
 * SAVEPOINT de la transacción del llamante:
 *  - si va bien, RELEASE: todo queda en la misma transacción, como siempre;
 *  - si falla, ROLLBACK TO SAVEPOINT: se deshace solo lo de `fn` y la transacción sigue viva
 *    (en PostgreSQL un error sin savepoint aborta la transacción entera, 25P02, y un try/catch
 *    normal no basta), se registra solo el código de error y se devuelve `fallback`.
 *
 * El log no lleva datos: ni ids de paciente, ni correos, ni el mensaje de Prisma (puede incluir
 * valores). Solo la etiqueta fija y el código (P20xx o el nombre del error).
 * No anidar: el nombre del savepoint es fijo.
 */
export async function bestEffortStaffEmail<T>(tx: Db, label: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  await tx.$executeRaw`SAVEPOINT staff_email_best_effort`;
  try {
    const result = await fn();
    await tx.$executeRaw`RELEASE SAVEPOINT staff_email_best_effort`;
    return result;
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT staff_email_best_effort`;
    const code = (error as { code?: unknown })?.code;
    logger.error(`Fallo al preparar emails al equipo (${label}); la operación sigue sin correo. Código: ${typeof code === 'string' ? code : (error as Error)?.name ?? 'desconocido'}`);
    return fallback;
  }
}
