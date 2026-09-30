import { ConflictException, Injectable } from '@nestjs/common';
import { PatientImportItem, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { IMPORT_LIMITS } from './import-limits';
import { PatientImportAccess } from './patient-import-access';
import { PatientImportJobsService } from './patient-import-jobs.service';

/** Margen entre createdAt y updatedAt que se sigue considerando "sin tocar desde el alta". */
const UNTOUCHED_TOLERANCE_MS = 2000;

/**
 * Condición de "sin actividad posterior" (spec, apartado 7): el paciente del lote no tiene citas,
 * tareas, objetivos, escalas, historia, documentos, consentimientos, informes, facturas, pagos,
 * cuenta de portal, recursos compartidos ni conversaciones, y su ÚNICO proceso es el mínimo del
 * lote, del propio importador y sin contenido. Se usa en la lectura y otra vez en el DELETE.
 */
export function noActivityWhere(workspaceId: string, actor: AuthUser, item: Pick<PatientImportItem, 'patientId' | 'clinicalProcessId'>): Prisma.PatientWhereInput {
  return {
    id: item.patientId,
    workspaceId,
    sessions: { none: {} },
    therapeuticTasks: { none: {} },
    therapyGoals: { none: {} },
    clinicalAssessments: { none: {} },
    clinicalHistory: { is: null },
    patientDocuments: { none: {} },
    consentRecords: { none: {} },
    clinicalReports: { none: {} },
    invoices: { none: {} },
    payments: { none: {} },
    portalAccounts: { none: {} },
    resourceShares: { none: {} },
    conversations: { none: {} },
    clinicalProcesses: {
      every: {
        id: item.clinicalProcessId,
        workspaceId,
        therapistId: actor.sub,
        consultationReason: null,
        goals: null,
        internalNotes: null,
        frequency: null,
      },
    },
  };
}

/**
 * Deshacer un lote: solo el importador, dentro de 7 días, y solo pacientes del propio lote sin
 * actividad. Es la corrección de altas erróneas del propio usuario, no un borrado de historia
 * clínica: un paciente con cualquier actividad se queda y se informa su fila.
 */
@Injectable()
export class PatientImportRevertService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PatientImportAccess,
    private readonly jobs: PatientImportJobsService,
  ) {}

  async revert(workspaceId: string, actor: AuthUser, id: string) {
    await this.access.assertCanImport(actor, 'REVERT');
    const job = await this.jobs.findOwnJob(workspaceId, actor, id);
    if (job.status !== 'COMPLETED' && job.status !== 'PARTIAL') {
      throw new ConflictException('Solo se puede deshacer una importación terminada');
    }
    const now = new Date();
    if (!job.revertibleUntil || job.revertibleUntil <= now) {
      throw new ConflictException('El plazo de 7 días para deshacer esta importación ha terminado');
    }

    const items = await this.prisma.patientImportItem.findMany({
      where: { workspaceId, jobId: id, job: { workspaceId, importerId: actor.sub } },
      orderBy: { rowNumber: 'asc' },
    });

    const notRevertedRows: number[] = [];
    let reverted = 0;
    for (let start = 0; start < items.length; start += IMPORT_LIMITS.BLOCK_SIZE) {
      const block = items.slice(start, start + IMPORT_LIMITS.BLOCK_SIZE);
      await this.prisma.$transaction(
        async (tx) => {
          let blockReverted = 0;
          for (const item of block) {
            if (await revertItem(tx, workspaceId, actor, item)) blockReverted += 1;
            else notRevertedRows.push(item.rowNumber);
          }
          await tx.patientImportJob.updateMany({
            where: { id, workspaceId, importerId: actor.sub },
            data: { revertedCount: { increment: blockReverted } },
          });
          reverted += blockReverted;
        },
        { timeout: IMPORT_LIMITS.BLOCK_TX_TIMEOUT_MS, maxWait: 10_000 },
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const remaining = await tx.patientImportItem.count({ where: { workspaceId, jobId: id } });
      await tx.patientImportJob.updateMany({
        where: { id, workspaceId, importerId: actor.sub, status: job.status },
        data: {
          ...(remaining === 0 ? { status: 'REVERTED' as const } : {}),
          revertedAt: now,
          // Un PARTIAL deshecho ya no se puede reanudar: se borra su fichero temporal.
          payload: null,
          payloadExpiresAt: null,
        },
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'PATIENT_IMPORT_BATCH_REVERTED',
          entityType: 'PatientImportJob',
          entityId: id,
          metadata: { reverted, notReverted: notRevertedRows.length, remaining },
        },
      });
    });

    return { ...(await this.jobs.getJobView(workspaceId, actor, id)), notRevertedRows };
  }
}

async function revertItem(tx: Prisma.TransactionClient, workspaceId: string, actor: AuthUser, item: PatientImportItem): Promise<boolean> {
  const where = noActivityWhere(workspaceId, actor, item);
  const patient = await tx.patient.findFirst({ where, select: { id: true, createdAt: true, updatedAt: true } });
  if (!patient) return false;
  // Editado después de importar (datos, estado, archivado…): cuenta como actividad.
  if (patient.updatedAt.getTime() - patient.createdAt.getTime() > UNTOUCHED_TOLERANCE_MS) return false;
  const process = await tx.clinicalProcess.findFirst({
    where: { id: item.clinicalProcessId, workspaceId, patientId: item.patientId },
    select: { createdAt: true, updatedAt: true },
  });
  if (process && process.updatedAt.getTime() - process.createdAt.getTime() > UNTOUCHED_TOLERANCE_MS) return false;
  // Notification no tiene relación en el esquema: se comprueba aparte.
  if ((await tx.notification.count({ where: { workspaceId, patientId: item.patientId } })) > 0) return false;

  await tx.patientImportItem.deleteMany({ where: { id: item.id, workspaceId, jobId: item.jobId } });
  await tx.clinicalProcess.deleteMany({ where: { id: item.clinicalProcessId, workspaceId, patientId: item.patientId } });
  // La misma condición en el DELETE: si entre la lectura y aquí apareció actividad, no se borra
  // nada y el bloque entero se deshace (las FK Restrict de citas, facturas y pagos lo impedirían
  // igualmente).
  const { count } = await tx.patient.deleteMany({ where });
  if (count !== 1) throw new ConflictException('Un paciente del lote tuvo actividad mientras se deshacía; vuelve a intentarlo');

  await tx.auditLog.create({
    data: {
      workspaceId,
      actorId: actor.sub,
      action: 'PATIENT_IMPORT_REVERTED',
      entityType: 'Patient',
      entityId: item.patientId,
      metadata: { importJobId: item.jobId, clinicalProcessId: item.clinicalProcessId },
    },
  });
  return true;
}
