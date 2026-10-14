import { PrismaClient, WorkspaceRole } from '@prisma/client';
import { hash } from 'bcryptjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// El seed escribe igual que la API: los campos clínicos van cifrados (ver clinical-crypto.ts).
import { encryptField } from '../src/common/crypto/field-encryption';
import { buildInviteUrl, createRegistrationInvite } from '../src/auth/invite-token.util';
import { pendingLegalDocuments, recordTermsAcceptances } from '../src/legal/terms-acceptance';
import { assertSeedAllowed, resolveSeedPassword, SEED_PASSWORD_ENV, SeedRefusal } from './seed-guard';

// Seed SOLO de desarrollo y CI. Antes de abrir ninguna conexión: se niega con NODE_ENV=production
// o contra una BD no local (salvo --allow-production-seed). Ver seed-guard.ts.
// Prisma lee apps/api/.env al conectar; se carga antes para que la salvaguarda vea la MISMA
// DATABASE_URL (sin pisar variables ya exportadas).
const apiEnvFile = join(__dirname, '..', '.env');
if (existsSync(apiEnvFile)) process.loadEnvFile(apiEnvFile);
try {
  assertSeedAllowed();
} catch (error) {
  if (error instanceof SeedRefusal) {
    console.error(`Seed rechazado: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
const prisma = new PrismaClient();
async function main() {
  const email = 'demo@asepsico.es';
  // Nunca una contraseña fija (repo público): SEED_DEMO_PASSWORD o una aleatoria por ejecución.
  const { password, generated } = resolveSeedPassword();
  const passwordHash = await hash(password, 12);
  const user = await prisma.user.upsert({ where: { email }, update: { passwordHash }, create: { email, passwordHash, firstName: 'Marta', lastName: 'Psicóloga' } });
  let membership = await prisma.workspaceMember.findFirst({ where: { userId: user.id }, include: { workspace: true } });
  if (!membership) {
    const workspace = await prisma.workspace.create({ data: { name: 'Consulta Demo' } });
    membership = await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER, isClinician: true }, include: { workspace: true } });
    const patient = await prisma.patient.create({ data: { workspaceId: workspace.id, firstName: 'Laura', lastName: 'Gómez', email: 'laura@example.com', consultationReason: encryptField('Ansiedad social y dificultades de sueño') } });
    const startsAt = new Date(); startsAt.setDate(startsAt.getDate() + 1); startsAt.setHours(10, 0, 0, 0);
    await prisma.session.create({ data: { workspaceId: workspace.id, patientId: patient.id, therapistId: user.id, startsAt, endsAt: new Date(startsAt.getTime() + 50 * 60 * 1000), notes: encryptField('Primera sesión de seguimiento') } });
  }
  // La cuenta demo (OWNER) acepta las condiciones vigentes; si no, la API le respondería 428.
  // Idempotente: solo registra lo pendiente (también tras publicar una versión nueva).
  const workspaceId = membership.workspaceId;
  await prisma.$transaction(async (tx) => {
    const pending = await pendingLegalDocuments(tx, workspaceId, user.id);
    if (pending.length > 0) await recordTermsAcceptances(tx, { workspaceId, userId: user.id, docs: pending, meta: { userAgent: 'seed' } });
  });
  // Invitación de registro de ejemplo (correo ficticio). Token aleatorio en cada ejecución:
  // nunca uno fijo, porque el repo es público. Revoca la del seed anterior.
  const { token } = await createRegistrationInvite(prisma, { email: 'nueva-consulta@example.com', createdBy: 'seed' });
  // La aleatoria se muestra UNA vez por la terminal; la de la variable de entorno nunca se imprime.
  console.log({ email, workspace: membership.workspace.name });
  if (generated) console.log(`Contraseña generada para ${email} (no se guarda en ningún sitio): ${password}`);
  else console.log(`Contraseña de ${email}: la de ${SEED_PASSWORD_ENV}.`);
  console.log(`Invitación de registro de prueba (nueva-consulta@example.com): ${buildInviteUrl('/register', token)}`);
}
main()
  .catch((error) => {
    console.error(error instanceof SeedRefusal ? `Seed rechazado: ${error.message}` : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
