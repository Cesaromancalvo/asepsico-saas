import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { encryptField } from '../src/common/crypto/field-encryption';

/**
 * Condición de Argos para «Tareas por revisar» (/follow-up/revisar): los avisos TASK_REVIEW de
 * GET /dashboard (nombre del paciente + título de la tarea) solo llegan a quien TRATA al paciente.
 *  - ASSISTANT: 403, sin tocar tareas ni mensajes.
 *  - OWNER/ADMIN no clínico (isClinician=false): `attention` sin TASK_REVIEW y pendingReviews=0,
 *    aunque haya tareas entregadas en su espacio (incluso si figura como terapeuta de un proceso
 *    activo por datos antiguos).
 *  - Control: el THERAPIST que trata al paciente sí recibe su aviso, y solo el suyo.
 * Datos 100 % ficticios.
 */

const TASK_TITLE_MARK = 'MARK-TAREA-ENTREGADA-FICTICIA';

describe('Dashboard: ASSISTANT no recibe avisos de tareas', () => {
  it('GET /dashboard como ASSISTANT → 403 sin consultar tareas, mensajes ni sesiones', async () => {
    const prisma: any = {
      workspaceMember: { findFirst: jest.fn() },
      session: { findMany: jest.fn(), count: jest.fn() },
      patient: { count: jest.fn(), findMany: jest.fn() },
      therapeuticTask: { findMany: jest.fn(async () => [{ id: 't1', title: TASK_TITLE_MARK, patient: { id: 'p1', firstName: 'P', lastName: 'F' } }]) },
      message: { findMany: jest.fn() },
    };
    const assistant = { sub: 'u-assistant', role: 'ASSISTANT', workspaceId: 'ws-1', email: 'recepcion@example.com' } as any;
    await expect(new DashboardService(prisma).get(assistant)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.therapeuticTask.findMany).not.toHaveBeenCalled();
    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(prisma.session.findMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------------------------
/**
 * Contra PostgreSQL REAL: el filtro de tareas es un `where` de Prisma y solo una BD de verdad dice
 * si deja pasar filas. Solo con RACE_DATABASE_URL hacia una base DESECHABLE ya migrada; con
 * RACE_DATABASE_REQUIRED=1 su ausencia hace fallar la suite. Escribe datos ficticios y no los borra.
 */
const url = process.env.RACE_DATABASE_URL;
if (process.env.RACE_DATABASE_REQUIRED === '1' && !url) {
  throw new Error('RACE_DATABASE_REQUIRED=1 pero RACE_DATABASE_URL no está definida: el test del dashboard no puede omitirse aquí.');
}
const describeDb = url ? describe : describe.skip;

describeDb('Dashboard: TASK_REVIEW solo para quien trata (PostgreSQL real)', () => {
  jest.setTimeout(60_000);
  let prisma: PrismaClient;
  const run = `dash-review-${Date.now()}`;
  let workspaceId: string;
  const ids: Record<'owner' | 'admin' | 'therapist' | 'assistant', string> = { owner: '', admin: '', therapist: '', assistant: '' };
  let treatedPatientId: string;
  let legacyPatientId: string;
  const actor = (key: keyof typeof ids, role: string) => ({ sub: ids[key], role, workspaceId, email: `${run}-${key}@example.com` }) as any;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const workspace = await prisma.workspace.create({ data: { name: `Consulta ficticia ${run}` } });
    workspaceId = workspace.id;
    const members: Array<[keyof typeof ids, 'OWNER' | 'ADMIN' | 'THERAPIST' | 'ASSISTANT', boolean]> = [
      ['owner', 'OWNER', false], ['admin', 'ADMIN', false], ['therapist', 'THERAPIST', true], ['assistant', 'ASSISTANT', false],
    ];
    for (const [key, role, isClinician] of members) {
      const user = await prisma.user.create({ data: { email: `${run}-${key}@example.com`, passwordHash: 'hash-ficticio', firstName: `Nombre-${key}`, lastName: 'Ficticio' } });
      await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role, isClinician } });
      ids[key] = user.id;
    }
    const treated = await prisma.patient.create({ data: { workspaceId, firstName: 'Paciente', lastName: 'Tratado' } });
    await prisma.clinicalProcess.create({ data: { workspaceId, patientId: treated.id, therapistId: ids.therapist, title: 'Proceso ficticio' } });
    // Datos antiguos: el OWNER no clínico figura como terapeuta de un proceso ACTIVO. Ni así.
    const legacy = await prisma.patient.create({ data: { workspaceId, firstName: 'Paciente', lastName: 'Heredado' } });
    await prisma.clinicalProcess.create({ data: { workspaceId, patientId: legacy.id, therapistId: ids.owner, title: 'Proceso ficticio heredado' } });
    treatedPatientId = treated.id; legacyPatientId = legacy.id;
    for (const patientId of [treated.id, legacy.id]) {
      await prisma.therapeuticTask.create({ data: { patientId, title: encryptField(`${TASK_TITLE_MARK}-${patientId}`)!, status: 'SUBMITTED', submittedAt: new Date() } });
    }
    expect(await prisma.therapeuticTask.count({ where: { status: 'SUBMITTED', patient: { workspaceId } } })).toBe(2);
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it.each([['OWNER', 'owner'], ['ADMIN', 'admin']] as const)('%s no clínico: attention sin TASK_REVIEW y pendingReviews 0 con tareas entregadas', async (role, key) => {
    const result: any = await new DashboardService(prisma as any).get(actor(key, role));
    expect(Array.isArray(result.attention)).toBe(true);
    expect(result.attention.filter((item: any) => item.type === 'TASK_REVIEW')).toEqual([]);
    expect(result.summary.pendingReviews).toBe(0);
    expect(JSON.stringify(result)).not.toContain(TASK_TITLE_MARK);
  });

  it('ASSISTANT → 403 también contra la BD real', async () => {
    await expect(new DashboardService(prisma as any).get(actor('assistant', 'ASSISTANT'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('control: el THERAPIST que trata recibe solo el aviso de su paciente, con el título descifrado', async () => {
    const result: any = await new DashboardService(prisma as any).get(actor('therapist', 'THERAPIST'));
    const reviews = result.attention.filter((item: any) => item.type === 'TASK_REVIEW');
    expect(reviews).toHaveLength(1);
    expect(reviews[0].href).toBe(`/patients/${treatedPatientId}/tasks`);
    expect(reviews[0].subtitle).toBe(`${TASK_TITLE_MARK}-${treatedPatientId}`);
    expect(JSON.stringify(result)).not.toContain(legacyPatientId);
    expect(result.summary.pendingReviews).toBe(1);
  });
});
