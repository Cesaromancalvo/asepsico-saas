import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { PatientImportJob, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { DuplicateAction } from './dto/patient-import.dto';
import { IMPORT_LIMITS } from './import-limits';
import { PatientImportAccess } from './patient-import-access';
import { PatientImportJobsService, Preview, StoredMapping } from './patient-import-jobs.service';
import { errorEntries } from './patient-import.service';
import { ErrorReportEntry } from './import-files';
import { ImportedValues } from './row-validation';
import { errorKind, isRowDataError } from './import-errors';
import { completeExistingPatient, createImportedPatient } from './patient-import-writes';

export interface PlanItem {
  row: number;
  action: 'CREATE' | 'COMPLETE';
  /** Solo COMPLETE: paciente existente del propio importador. */
  patientId?: string;
}


/** Sin avance del cursor en este tiempo, un PROCESSING se considera interrumpido. */
export const STALLED_AFTER_MS = 5 * 60 * 1000;
export const isStalled = (updatedAt: Date, now = new Date()) => now.getTime() - updatedAt.getTime() > STALLED_AFTER_MS;

/**
 * Confirmación de un lote (spec, apartado 7):
 *
 * - El plan (qué filas se crean o completan) se calcula UNA vez, en el servidor, a partir del
 *   fichero y el mapeo guardados; del cliente solo se aceptan decisiones sobre filas que el propio
 *   servidor marcó como posible duplicado. Se guarda en el lote (solo números de fila e ids).
 * - Se ejecuta en bloques de 100, cada uno en su transacción: paciente + proceso mínimo +
 *   vínculo con el lote + auditoría + avance del cursor. Si un bloque falla, no deja rastro;
 *   los anteriores quedan completos y el lote pasa a PARTIAL.
 * - Reintento idempotente: volver a confirmar un PARTIAL reanuda en el cursor con el MISMO plan.
 *   El cursor avanza en la misma transacción que el bloque, con compare-and-set, así que un bloque
 *   nunca se aplica dos veces (ni con dos confirmaciones simultáneas).
 * - Los pacientes quedan SIEMPRE a nombre del importador (actor.sub): no se acepta ningún
 *   therapistId del cliente. No se crean cuentas de portal ni se envían emails.
 */
@Injectable()
export class PatientImportConfirmService {
  private readonly logger = new Logger(PatientImportConfirmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PatientImportAccess,
    private readonly jobs: PatientImportJobsService,
  ) {}

  async confirm(workspaceId: string, actor: AuthUser, id: string, decisions: Array<{ row: number; action: DuplicateAction }> = []) {
    await this.access.assertCanImport(actor, 'CONFIRM');
    const job = await this.jobs.findOwnJob(workspaceId, actor, id);
    // Un PROCESSING sin avances durante minutos es una confirmación interrumpida (caída del
    // proceso): se puede reanudar igual que un PARTIAL.
    const stalled = job.status === 'PROCESSING' && isStalled(job.updatedAt);
    if (job.status !== 'PREVIEWED' && job.status !== 'PARTIAL' && !stalled) {
      throw new ConflictException(
        job.status === 'UPLOADED' ? 'Revisa la vista previa antes de confirmar' : 'Esta importación ya no se puede confirmar',
      );
    }
    const payload = await this.jobs.loadPayload(workspaceId, job);
    const mapping = job.mapping as unknown as StoredMapping;
    const firstRun = job.status === 'PREVIEWED';

    let plan: PlanItem[];
    let claimData: Prisma.PatientImportJobUpdateManyMutationInput = { status: 'PROCESSING' };
    if (firstRun) {
      const preview = await this.jobs.buildPreview(workspaceId, actor, payload, mapping);
      const built = buildPlan(preview, decisions);
      plan = built.plan;
      const now = new Date();
      claimData = {
        status: 'PROCESSING',
        plan: plan as unknown as object,
        totalRows: preview.summary.total,
        skippedCount: built.skipped,
        errorCount: built.errors,
        errorReport: errorEntries(preview) as unknown as object,
        confirmedAt: now,
        revertibleUntil: new Date(now.getTime() + IMPORT_LIMITS.REVERT_WINDOW_MS),
      };
    } else {
      plan = (job.plan as unknown as PlanItem[]) ?? [];
    }

    // Toma del lote (compare-and-set sobre estado y cursor): una segunda confirmación simultánea
    // no encuentra la fila en el estado esperado y recibe 409 sin tocar nada.
    const claimed = await this.prisma.patientImportJob.updateMany({
      where: { id, workspaceId, importerId: actor.sub, status: job.status, cursor: job.cursor, updatedAt: job.updatedAt },
      data: claimData,
    });
    if (claimed.count === 0) throw new ConflictException('La importación ya se está procesando');

    const valuesByRow = new Map(
      this.jobs
        .validate(payload, mapping)
        .filter((row) => row.kind === 'VALID')
        .map((row) => [row.rowNumber, row.values as ImportedValues]),
    );

    for (let start = job.cursor; start < plan.length; start += IMPORT_LIMITS.BLOCK_SIZE) {
      const block = plan.slice(start, start + IMPORT_LIMITS.BLOCK_SIZE);
      try {
        await this.runBlock(workspaceId, actor, job, start, block, valuesByRow);
      } catch (error) {
        // Sin valores: los errores de base de datos pueden incluir datos de la fila en su mensaje.
        this.logger.warn(`Importación ${id}: falló el bloque que empieza en la posición ${start} (${errorKind(error)})`);
        try {
          // Un fallo de sistema (conexión, timeout, conflicto) deja el lote en PARTIAL para
          // reintentar. Un fallo de DATOS se aísla fila a fila: la fila culpable se marca como
          // rechazada y el resto del bloque se importa, así un dato raro no bloquea el lote
          // para siempre.
          if (!isRowDataError(error)) throw error;
          await this.runBlockRowByRow(workspaceId, actor, job, start, block, valuesByRow);
        } catch (fallbackError) {
          if (fallbackError !== error) {
            this.logger.warn(`Importación ${id}: falló el aislamiento por filas (${errorKind(fallbackError)})`);
          }
          await this.finish(workspaceId, actor, job, 'PARTIAL', payload.format);
          return this.jobs.getJobView(workspaceId, actor, id);
        }
      }
    }

    await this.finish(workspaceId, actor, job, 'COMPLETED', payload.format);
    return this.jobs.getJobView(workspaceId, actor, id);
  }

  private async runBlock(
    workspaceId: string,
    actor: AuthUser,
    job: PatientImportJob,
    start: number,
    block: PlanItem[],
    valuesByRow: Map<number, ImportedValues>,
  ) {
    await this.prisma.$transaction(
      async (tx) => {
        let created = 0;
        let completed = 0;
        let skipped = 0;
        let errors = 0;
        for (const item of block) {
          const values = valuesByRow.get(item.row);
          if (!values) {
            errors += 1; // no debería ocurrir: la validación es determinista
            continue;
          }
          if (item.action === 'CREATE') {
            await createImportedPatient(tx, workspaceId, actor, job.id, item.row, values);
            created += 1;
          } else if (item.patientId && (await completeExistingPatient(tx, workspaceId, actor, job.id, item.patientId, values))) {
            completed += 1;
          } else {
            skipped += 1;
          }
        }
        const advanced = await tx.patientImportJob.updateMany({
          where: { id: job.id, workspaceId, importerId: actor.sub, status: 'PROCESSING', cursor: start },
          data: {
            cursor: start + block.length,
            createdCount: { increment: created },
            completedCount: { increment: completed },
            skippedCount: { increment: skipped },
            errorCount: { increment: errors },
          },
        });
        if (advanced.count !== 1) throw new ConflictException('El lote cambió durante la importación');
      },
      { timeout: IMPORT_LIMITS.BLOCK_TX_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  /**
   * Reintenta un bloque fallido fila a fila, cada una en su transacción (que también avanza el
   * cursor en uno). Si una fila falla por sus datos, se registra como rechazada (contador de
   * errores e informe, sin valores) y el cursor avanza igualmente. Un fallo de sistema se propaga.
   */
  private async runBlockRowByRow(
    workspaceId: string,
    actor: AuthUser,
    job: PatientImportJob,
    start: number,
    block: PlanItem[],
    valuesByRow: Map<number, ImportedValues>,
  ) {
    for (let offset = 0; offset < block.length; offset += 1) {
      const position = start + offset;
      try {
        await this.runBlock(workspaceId, actor, job, position, [block[offset]], valuesByRow);
      } catch (error) {
        if (!isRowDataError(error)) throw error;
        this.logger.warn(`Importación ${job.id}: fila ${block[offset].row} rechazada al guardar (${errorKind(error)})`);
        await this.rejectRow(workspaceId, actor, job, position, block[offset].row);
      }
    }
  }

  private async rejectRow(workspaceId: string, actor: AuthUser, job: PatientImportJob, position: number, row: number) {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.patientImportJob.findFirst({
        where: { id: job.id, workspaceId, importerId: actor.sub },
        select: { errorReport: true },
      });
      const report = Array.isArray(current?.errorReport) ? (current!.errorReport as unknown as ErrorReportEntry[]) : [];
      const advanced = await tx.patientImportJob.updateMany({
        where: { id: job.id, workspaceId, importerId: actor.sub, status: 'PROCESSING', cursor: position },
        data: {
          cursor: position + 1,
          errorCount: { increment: 1 },
          errorReport: [...report, { row, field: 'fila', code: 'ROW_REJECTED' }] as unknown as object,
        },
      });
      if (advanced.count !== 1) throw new ConflictException('El lote cambió durante la importación');
    });
  }

  private async finish(workspaceId: string, actor: AuthUser, job: PatientImportJob, status: 'COMPLETED' | 'PARTIAL', format: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.patientImportJob.updateMany({
        where: { id: job.id, workspaceId, importerId: actor.sub, status: 'PROCESSING' },
        data: {
          status,
          finishedAt: new Date(),
          // Terminado: el fichero temporal se borra ya. En PARTIAL se conserva (cifrado, hasta las
          // 24 h de la subida) para poder reanudar; "cancelar" lo borra antes.
          ...(status === 'COMPLETED' ? { payload: null, payloadExpiresAt: null } : {}),
        },
      });
      const counts = await tx.patientImportJob.findFirst({
        where: { id: job.id, workspaceId },
        select: { totalRows: true, createdCount: true, completedCount: true, skippedCount: true, errorCount: true },
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'PATIENT_IMPORT_BATCH',
          entityType: 'PatientImportJob',
          entityId: job.id,
          // Recuentos y formato técnico. NUNCA nombres, emails ni nombre del fichero.
          metadata: { status, format, ...(counts ?? {}) },
        },
      });
    });
  }
}

export function buildPlan(preview: Preview, decisions: Array<{ row: number; action: DuplicateAction }>) {
  const byRow = new Map(preview.rows.map((row) => [row.rowNumber, row]));
  const decided = new Map<number, DuplicateAction>();
  for (const decision of decisions) {
    const row = byRow.get(decision.row);
    if (!row || row.status !== 'DUPLICATE') {
      throw new BadRequestException(`La fila ${decision.row} no es un posible duplicado`);
    }
    if (decision.action === 'COMPLETE' && !(row.duplicate?.source === 'EXISTING' && row.duplicate.canComplete)) {
      throw new BadRequestException(`La fila ${decision.row} no se puede usar para completar un paciente existente`);
    }
    decided.set(decision.row, decision.action);
  }

  const plan: PlanItem[] = [];
  let skipped = 0;
  let errors = 0;
  for (const row of preview.rows) {
    if (row.status === 'VALID') plan.push({ row: row.rowNumber, action: 'CREATE' });
    else if (row.status === 'ERROR') errors += 1;
    else if (row.status === 'IGNORED') skipped += 1;
    else {
      const action = decided.get(row.rowNumber) ?? 'SKIP';
      if (action === 'CREATE') plan.push({ row: row.rowNumber, action: 'CREATE' });
      else if (action === 'COMPLETE') plan.push({ row: row.rowNumber, action: 'COMPLETE', patientId: row.duplicate!.patientId });
      else skipped += 1;
    }
  }
  return { plan, skipped, errors };
}
