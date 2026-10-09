/**
 * Crea una invitación para dar de alta un workspace NUEVO (registro cerrado). Es la única forma
 * de crearlas: no hay endpoint. Quien ejecuta esto necesita acceso directo a la BD (DATABASE_URL),
 * así que en la práctica solo puede hacerlo el operador de la plataforma.
 *
 *   npm run invites:create -- --email persona@example.com [--created-by cli:cesar]
 *
 * Entorno: DATABASE_URL (BD destino) y WEB_ORIGIN (dominio de la web para el enlace).
 * Imprime el enlace UNA vez: en la BD solo queda el hash del token. Caduca a los 14 días.
 * Crear una invitación nueva al mismo correo revoca las anteriores pendientes.
 */
import { PrismaClient } from '@prisma/client';
import { buildInviteUrl, createRegistrationInvite, normalizeEmail } from '../../src/auth/invite-token.util';

function arg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const rawEmail = arg('email');
  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    console.error('Uso: npm run invites:create -- --email persona@example.com [--created-by cli:nombre]');
    process.exit(1);
  }
  const email = normalizeEmail(rawEmail);
  const createdBy = (arg('created-by') ?? 'cli').slice(0, 100);
  if (!process.env.WEB_ORIGIN) console.warn('Aviso: WEB_ORIGIN no está definido; el enlace apunta a http://localhost:3000.');

  const prisma = new PrismaClient();
  try {
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      console.error('Ya existe una cuenta con ese correo: no se crea la invitación.');
      process.exit(2);
    }
    const { token, invite } = await createRegistrationInvite(prisma, { email, createdBy });
    console.log(`Invitación ${invite.id} para ${invite.email}, caduca el ${invite.expiresAt.toISOString()}.`);
    console.log('Enlace (se muestra solo esta vez; envíalo tú por un canal privado):');
    console.log(buildInviteUrl('/register', token));
    if (process.env.DEMO_ENVIRONMENT === 'true') {
      // Piloto demo: los pacientes inventados se siembran DESPUÉS de que la persona se registre
      // (antes no existe su espacio). Mismo comando que el espacio de demostración del titular.
      console.log('Cuando se haya registrado, carga sus pacientes inventados con:');
      console.log(`  DEMO_ENVIRONMENT=true npm run db:seed-demo-workspace -- --owner-email ${invite.email}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('No se pudo crear la invitación:', error instanceof Error ? error.message : error);
  process.exit(1);
});
