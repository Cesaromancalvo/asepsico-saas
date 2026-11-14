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
 *
 * E1 · Piloto demo: con DEMO_ENVIRONMENT=true la invitación sale marcada con espacio de prueba
 * cargado (withSampleData): al registrarse, su espacio recibe los pacientes inventados. Para una
 * invitación demo con el espacio vacío: --sin-datos-ejemplo. Fuera del entorno demo nunca se marca.
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
    const withSampleData = process.env.DEMO_ENVIRONMENT === 'true' && !process.argv.includes('--sin-datos-ejemplo');
    const { token, invite } = await createRegistrationInvite(prisma, { email, createdBy, withSampleData });
    console.log(`Invitación ${invite.id} para ${invite.email}, caduca el ${invite.expiresAt.toISOString()}.`);
    console.log('Enlace (se muestra solo esta vez; envíalo tú por un canal privado):');
    console.log(buildInviteUrl('/register', token));
    if (invite.withSampleData) {
      // E1: los pacientes inventados se cargan solos al registrarse (antes no existe su espacio).
      console.log('Espacio de prueba: al registrarse, su espacio se cargará con pacientes inventados (E1).');
      console.log('Si la carga fallase (queda en el log de la API), cárgalo a mano con:');
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
