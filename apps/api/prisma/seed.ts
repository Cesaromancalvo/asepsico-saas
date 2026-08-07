import { PrismaClient, WorkspaceRole } from '@prisma/client';
import { hash } from 'bcryptjs';
const prisma = new PrismaClient();
async function main() {
  const email = 'demo@asepsico.es';
  const passwordHash = await hash('AsePsico2026!', 12);
  const user = await prisma.user.upsert({ where: { email }, update: { passwordHash }, create: { email, passwordHash, firstName: 'Marta', lastName: 'Psicóloga' } });
  let membership = await prisma.workspaceMember.findFirst({ where: { userId: user.id }, include: { workspace: true } });
  if (!membership) {
    const workspace = await prisma.workspace.create({ data: { name: 'Consulta Demo' } });
    membership = await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER }, include: { workspace: true } });
    const patient = await prisma.patient.create({ data: { workspaceId: workspace.id, firstName: 'Laura', lastName: 'Gómez', email: 'laura@example.com', consultationReason: 'Ansiedad social y dificultades de sueño' } });
    const startsAt = new Date(); startsAt.setDate(startsAt.getDate() + 1); startsAt.setHours(10, 0, 0, 0);
    await prisma.session.create({ data: { workspaceId: workspace.id, patientId: patient.id, therapistId: user.id, startsAt, endsAt: new Date(startsAt.getTime() + 50 * 60 * 1000), notes: 'Primera sesión de seguimiento' } });
  }
  console.log({ email, password: 'AsePsico2026!', workspace: membership.workspace.name });
}
main().finally(() => prisma.$disconnect());
