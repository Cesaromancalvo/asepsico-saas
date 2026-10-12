import { PrismaClient } from '@prisma/client';
import { SessionsService } from '../src/sessions/sessions.service';
import { ClinicalProcessesService } from '../src/clinical-processes/clinical-processes.service';

/**
 * Carrera crear cita / cerrar proceso contra PostgreSQL REAL (bloqueos de fila de verdad).
 *
 * Solo se ejecuta si RACE_DATABASE_URL apunta a una base de datos DESECHABLE ya migrada (p. ej. un
 * contenedor postgres:16 temporal con `prisma migrate deploy`); si no, se omite. Escribe datos
 * ficticios y no los borra: nunca la apuntes a una base de datos con datos que importen.
 *
 * En el job `postgres-integration` del CI se ejecuta con RACE_DATABASE_REQUIRED=1: ahí la falta de
 * RACE_DATABASE_URL hace FALLAR la suite en lugar de omitirla en silencio. En el job `quality` (sin
 * PostgreSQL) y en local sin la variable se sigue omitiendo.
 *
 * Invariante: un proceso CLOSED o DISCHARGED nunca termina con citas SCHEDULED futuras, se cierre
 * cancelando (cancelFutureSessions) o sin cancelar (409).
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error(
    'RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test de carrera crear cita / cerrar proceso no puede omitirse aquí.',
  );
}
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

describeDb('Carrera crear cita vs. cerrar proceso (PostgreSQL real)', () => {
  let prisma: PrismaClient;
  const run = `race-${Date.now()}`;
  let workspaceId: string;
  let patientId: string;
  let therapistId: string;
  const therapist = () => ({ sub: therapistId, workspaceId, role: 'THERAPIST', email: `${run}@example.com` }) as any;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const workspace = await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}` } });
    const user = await prisma.user.create({ data: { email: `${run}@example.com`, passwordHash: 'hash-ficticio', firstName: 'Profesional', lastName: 'Ficticio' } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'THERAPIST', isClinician: true } });
    const patient = await prisma.patient.create({ data: { workspaceId: workspace.id, firstName: 'Paciente', lastName: 'Ficticio' } });
    workspaceId = workspace.id; patientId = patient.id; therapistId = user.id;
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  async function raceOnce(iteration: number, cancelFutureSessions: boolean) {
    const process = await prisma.clinicalProcess.create({ data: { workspaceId, patientId, therapistId, title: 'Proceso ficticio' } });
    const sessions = new SessionsService(prisma as any);
    const processes = new ClinicalProcessesService(prisma as any);
    const base = Date.now() + (iteration + 1) * 30 * 86_400_000;
    const creates = Array.from({ length: 6 }, (_, slot) => sessions.create(workspaceId, therapist(), {
      patientId, clinicalProcessId: process.id,
      startsAt: new Date(base + slot * 3_600_000).toISOString(), endsAt: new Date(base + slot * 3_600_000 + 2_700_000).toISOString(),
    } as any));
    const close = processes.changeStatus(workspaceId, therapist(), process.id, 'CLOSED', { cancelFutureSessions });
    const results = await Promise.allSettled([...creates, close]);
    // Ningún fallo inesperado: las altas tardías → 400, el cierre sin cancelar → 409.
    for (const result of results) {
      if (result.status === 'rejected') expect([400, 409]).toContain((result.reason as any)?.getStatus?.());
    }

    const final = await prisma.clinicalProcess.findFirstOrThrow({ where: { id: process.id, workspaceId } });
    const scheduled = await prisma.session.count({ where: { workspaceId, clinicalProcessId: process.id, status: 'SCHEDULED', startsAt: { gte: new Date() } } });
    if (final.status === 'CLOSED') expect(scheduled).toBe(0);
    return final.status;
  }

  it('cerrando con cancelFutureSessions: nunca queda una SCHEDULED futura en un proceso CLOSED', async () => {
    const statuses: string[] = [];
    for (let i = 0; i < 15; i += 1) statuses.push(await raceOnce(i, true));
    expect(statuses.every((status) => status === 'CLOSED')).toBe(true);
  });

  it('cerrando sin cancelar: o 409 y sigue ACTIVO, o se cierra sin ninguna SCHEDULED futura', async () => {
    for (let i = 0; i < 15; i += 1) await raceOnce(100 + i, false);
  });
});
