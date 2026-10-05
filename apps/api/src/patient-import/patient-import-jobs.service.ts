import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PatientImportJob, PatientImportStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ColumnTarget, IGNORE_COLUMN, ImportField, MULTI_COLUMN_FIELDS, proposeMapping } from './column-mapping';
import { ImportPayload, expiredPayload, openPayload } from './import-payload';
import { IMPORT_LIMITS } from './import-limits';
import { ImportFileError } from './parsing/import-file-error';
import { ColumnAssignment, DuplicateMatch, OwnPatient, ValidatedRow, findDuplicates, validateRows } from './row-validation';

export interface StoredMapping {
  hasHeaderRow: boolean;
  /** Solo columnas asignadas a un campo (índice → campo). Sin valores de celdas. */
  columns: ColumnAssignment[];
}

export interface PreviewRow extends Omit<ValidatedRow, 'kind'> {
  status: 'VALID' | 'ERROR' | 'DUPLICATE' | 'IGNORED';
  duplicate?: DuplicateMatch;
}

export interface Preview {
  rows: PreviewRow[];
  summary: { total: number; valid: number; errors: number; duplicates: number; ignored: number };
}

/**
 * Lo que se lee para describir un lote: nunca `payload` ni `mapping`. `payloadExpiresAt` se pone a
 * null junto con `payload`, así que basta para saber si el fichero temporal sigue disponible.
 */
export const JOB_VIEW_SELECT = {
  id: true,
  status: true,
  format: true,
  totalRows: true,
  cursor: true,
  plan: true,
  createdCount: true,
  completedCount: true,
  skippedCount: true,
  errorCount: true,
  revertedCount: true,
  createdAt: true,
  confirmedAt: true,
  finishedAt: true,
  payloadExpiresAt: true,
  revertibleUntil: true,
  revertedAt: true,
  updatedAt: true,
} satisfies Prisma.PatientImportJobSelect;

type JobViewRow = Prisma.PatientImportJobGetPayload<{ select: typeof JOB_VIEW_SELECT }>;

const WAITING_STATUSES: PatientImportStatus[] = ['UPLOADED', 'PREVIEWED'];

/**
 * Piezas comunes de la importación: acceso a los lotes del propio importador, fichero temporal,
 * mapeo y vista previa. Todas las lecturas filtran por workspaceId E importerId: un lote solo lo
 * ve y lo toca quien lo subió (ni siquiera OWNER/ADMIN ven lotes ajenos).
 */
@Injectable()
export class PatientImportJobsService {
  constructor(private readonly prisma: PrismaService) {}

  async findOwnJob(workspaceId: string, actor: AuthUser, id: string): Promise<PatientImportJob> {
    const job = await this.prisma.patientImportJob.findFirst({ where: { id, workspaceId, importerId: actor.sub } });
    if (!job) throw new NotFoundException('Importación no encontrada');
    return job;
  }

  /**
   * Devuelve el fichero temporal descifrado. Si pasaron las 24 horas se borra en el acto (aunque
   * la limpieza periódica aún no haya pasado) y se responde 410.
   */
  async loadPayload(workspaceId: string, job: PatientImportJob, now = new Date()): Promise<ImportPayload> {
    if (!job.payload || !job.payloadExpiresAt || job.payloadExpiresAt <= now) {
      if (job.payload) await this.discardPayload(workspaceId, job.id, WAITING_STATUSES.includes(job.status) ? 'EXPIRED' : undefined);
      throw expiredPayload();
    }
    return openPayload(job.payload);
  }

  async discardPayload(workspaceId: string, id: string, status?: PatientImportStatus) {
    await this.prisma.patientImportJob.updateMany({
      where: { id, workspaceId },
      data: { payload: null, payloadExpiresAt: null, ...(status ? { status } : {}) },
    });
  }

  /** Pacientes del PROPIO importador (con un proceso suyo). Nunca los de toda la consulta. */
  async ownPatients(workspaceId: string, actor: AuthUser): Promise<OwnPatient[]> {
    return this.prisma.patient.findMany({
      where: { workspaceId, clinicalProcesses: { some: { workspaceId, therapistId: actor.sub } } },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, birthDate: true, status: true },
    });
  }

  /** Valida el mapeo recibido contra el fichero. Las columnas clínicas no se pueden asignar. */
  validateMapping(payload: ImportPayload, hasHeaderRow: boolean, requested: Array<{ index: number; field: ColumnTarget }>): StoredMapping {
    const seenIndexes = new Set<number>();
    const seenFields = new Set<ImportField>();
    const columns: ColumnAssignment[] = [];
    for (const { index, field } of requested) {
      if (index >= payload.columnCount) throw new BadRequestException(`La columna ${index + 1} no existe en el fichero`);
      if (seenIndexes.has(index)) throw new BadRequestException(`La columna ${index + 1} está asignada dos veces`);
      seenIndexes.add(index);
      if (field === IGNORE_COLUMN) continue;
      // Se decide por la cabecera leída al subir, tenga o no el usuario la primera fila por cabecera.
      if (payload.clinicalColumns.includes(index)) {
        throw new BadRequestException(`La columna ${index + 1} puede contener información clínica y no se importará`);
      }
      if (payload.discardedColumns?.includes(index)) {
        throw new BadRequestException(
          `La columna ${index + 1} se descartó en la vista previa anterior; vuelve a subir el fichero para asignarla`,
        );
      }
      if (seenFields.has(field) && !MULTI_COLUMN_FIELDS.has(field)) {
        throw new BadRequestException(`El campo ${field} solo puede asignarse a una columna`);
      }
      seenFields.add(field);
      columns.push({ index, field });
    }
    if (!seenFields.has('nombre') || !seenFields.has('apellidos')) {
      throw new BadRequestException('Asigna al menos las columnas de nombre y apellidos');
    }
    return { hasHeaderRow, columns };
  }

  dataRows(payload: ImportPayload, mapping: Pick<StoredMapping, 'hasHeaderRow'>) {
    const rows = mapping.hasHeaderRow ? payload.rows.slice(1) : payload.rows;
    if (rows.length > IMPORT_LIMITS.MAX_DATA_ROWS) throw new ImportFileError('TOO_MANY_ROWS').toHttp();
    return rows;
  }

  validate(payload: ImportPayload, mapping: StoredMapping): ValidatedRow[] {
    // Defensa en profundidad: aunque el mapeo guardado se validó al recibirlo, se vuelve a
    // excluir cualquier columna clínica antes de leer una sola celda.
    const columns = mapping.columns.filter((c) => !payload.clinicalColumns.includes(c.index));
    return validateRows(this.dataRows(payload, mapping), columns, { format: payload.format, date1904: payload.date1904 });
  }

  async buildPreview(workspaceId: string, actor: AuthUser, payload: ImportPayload, mapping: StoredMapping): Promise<Preview> {
    const validated = this.validate(payload, mapping);
    const duplicates = findDuplicates(validated, await this.ownPatients(workspaceId, actor));
    const rows: PreviewRow[] = validated.map(({ kind, ...row }) => {
      const duplicate = duplicates.get(row.rowNumber);
      return duplicate ? { ...row, status: 'DUPLICATE', duplicate } : { ...row, status: kind };
    });
    const count = (status: PreviewRow['status']) => rows.filter((r) => r.status === status).length;
    return {
      rows,
      summary: { total: rows.length, valid: count('VALID'), errors: count('ERROR'), duplicates: count('DUPLICATE'), ignored: count('IGNORED') },
    };
  }

  columnsView(payload: ImportPayload, mapping?: StoredMapping | null) {
    const hasHeaderRow = mapping?.hasHeaderRow ?? true;
    const proposal = proposeMapping(payload.rows[0]?.cells ?? [], payload.columnCount, hasHeaderRow).map((column) => {
      const clinical = payload.clinicalColumns.includes(column.index);
      const discarded = Boolean(payload.discardedColumns?.includes(column.index));
      return { ...column, clinical, discarded, suggestedField: clinical || discarded ? IGNORE_COLUMN : column.suggestedField };
    });
    if (!mapping) return proposal.map((column) => ({ ...column, field: column.suggestedField }));
    return proposal.map((column) => ({
      ...column,
      field: (mapping.columns.find((c) => c.index === column.index)?.field ?? IGNORE_COLUMN) as ColumnTarget,
    }));
  }

  async getJobView(workspaceId: string, actor: AuthUser, id: string) {
    const job = await this.prisma.patientImportJob.findFirst({
      where: { id, workspaceId, importerId: actor.sub },
      select: JOB_VIEW_SELECT,
    });
    if (!job) throw new NotFoundException('Importación no encontrada');
    return toJobView(job);
  }
}

export function toJobView(job: JobViewRow, now = new Date()) {
  const plannedRows = Array.isArray(job.plan) ? job.plan.length : 0;
  const payloadAvailable = Boolean(job.payloadExpiresAt && job.payloadExpiresAt > now);
  return {
    id: job.id,
    status: job.status,
    format: job.format,
    totalRows: job.totalRows,
    plannedRows,
    processedRows: job.cursor,
    createdCount: job.createdCount,
    completedCount: job.completedCount,
    skippedCount: job.skippedCount,
    errorCount: job.errorCount,
    revertedCount: job.revertedCount,
    createdAt: job.createdAt,
    confirmedAt: job.confirmedAt,
    finishedAt: job.finishedAt,
    expiresAt: payloadAvailable ? job.payloadExpiresAt : null,
    revertibleUntil: job.revertibleUntil,
    revertedAt: job.revertedAt,
    canRetry:
      payloadAvailable &&
      (job.status === 'PARTIAL' || (job.status === 'PROCESSING' && now.getTime() - job.updatedAt.getTime() > 5 * 60 * 1000)),
    canRevert:
      (job.status === 'COMPLETED' || job.status === 'PARTIAL') &&
      Boolean(job.revertibleUntil && job.revertibleUntil > now) &&
      job.createdCount > job.revertedCount,
  };
}
