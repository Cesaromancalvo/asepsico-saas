/**
 * Borra las solicitudes de alta en el portal caducadas (14 días sin respuesta) y audita cada una
 * (PORTAL_SIGNUP_REQUEST_EXPIRED, sin datos personales). La API ya las purga al listar y al
 * recibir solicitudes; este script cubre los espacios sin actividad. Pensado para un cron diario.
 *
 *   npm run portal-signup:purge
 *
 * Entorno: solo DATABASE_URL. Solo imprime el recuento.
 */
import { PrismaClient } from '@prisma/client';
import { SignupRequestsService } from '../../src/portal-signup/signup-requests.service';

async function main() {
  const prisma = new PrismaClient();
  try {
    const purged = await new SignupRequestsService(prisma as any).purgeExpired();
    console.log(`Solicitudes de alta caducadas borradas: ${purged}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`Error al purgar solicitudes de alta: ${error?.code ?? error?.name ?? 'desconocido'}`);
  process.exit(1);
});
