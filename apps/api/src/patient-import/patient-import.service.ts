import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ColumnTarget } from './column-mapping';
import { ErrorReportEntry, errorReportCsv, templateCsv, templateXlsx } from './import-files';
import { IMPORT_LIMITS } from './import-limits';
import { buildPayload, sealPayload } from './import-payload';
import { ImportFileError } from './parsing/import-file-error';
import { readCsv } from './parsing/csv-reader';
import { ImportFormat, RawSheet } from './parsing/raw-table';
import { isLegacyXls, isZip, readXlsx } from './parsing/xlsx-reader';
import { PatientImportAccess } from './patient-import-access';
import { JOB_VIEW_SELECT, PatientImportJobsService, Preview, toJobView } from './patient-import-jobs.service';

export interface UploadedFile {
  buffer: Buffer;
  size: number;
  originalname?: string;
}

/**
 * Subida, mapeo y vista previa, cancelación, informe de errores y plantilla. La confirmación y
 * el deshacer viven en PatientImportConfirmService y PatientImportRevertService.
 *
 * Nada de lo que se registra (logs, auditoría) contiene valores de celdas ni el nombre del fichero.
 */
@Injectable()
export class PatientImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PatientImportAccess,
    private readonly jobs: PatientImportJobsService,
  ) {}

  async template(actor: AuthUser, format: 'csv' | 'xlsx') {
    await this.access.assertCanImport(actor, 'TEMPLATE');
    return format === 'xlsx'
      ? {
          buffer: templateXlsx(),
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileName: 'plantilla-pacientes.xlsx',
        }
      : { buffer: templateCsv(), contentType: 'text/csv; charset=utf-8', fileName: 'plantilla-pacientes.csv' };
  }

  async upload(workspaceId: string, actor: AuthUser, file: UploadedFile | undefined, sheet = 0) {
    await this.access.assertCanImport(actor, 'UPLOAD');
    const { format, parsed } = this.parse(file, sheet);
    if (parsed.rows.length === 0) throw new ImportFileError('EMPTY_FILE').toHttp();

    const payload = buildPayload(format, parsed);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + IMPORT_LIMITS.PAYLOAD_TTL_MS);
    const rowCount = Math.max(0, payload.rows.length - 1);

    const job = await this.prisma.$transaction(async (tx) => {
      const created = await tx.patientImportJob.create({
        data: {
          workspaceId,
          importerId: actor.sub,
          format,
          payload: sealPayload(payload),
          payloadExpiresAt: expiresAt,
          totalRows: rowCount,
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'PATIENT_IMPORT_UPLOADED',
          entityType: 'PatientImportJob',
          entityId: created.id,
          // Solo el formato técnico y recuentos: ni nombre de fichero ni contenido.
          metadata: { format, rowCount, columnCount: payload.columnCount, clinicalColumnsDiscarded: payload.clinicalColumns.length },
        },
      });
      return created;
    });

    const clinical = new Set(payload.clinicalColumns);
    return {
      id: job.id,
      format,
      sheetNames: payload.sheetNames,
      sheetIndex: payload.sheetIndex,
      rowCount,
      columns: this.jobs.columnsView(payload).map(({ field: _field, ...column }) => column),
      sampleRows: payload.rows.slice(1, 6).map((row) => ({
        rowNumber: row.rowNumber,
        cells: row.cells.map((cell, index) => (clinical.has(index) ? '' : cell)),
      })),
      expiresAt,
    };
  }

  async preview(
    workspaceId: string,
    actor: AuthUser,
    id: string,
    dto: { hasHeaderRow: boolean; columns: Array<{ index: number; field: ColumnTarget }> },
  ) {
    await this.access.assertCanImport(actor, 'PREVIEW');
    const job = await this.jobs.findOwnJob(workspaceId, actor, id);
    if (job.status !== 'UPLOADED' && job.status !== 'PREVIEWED') {
      throw new ConflictException('Esta importación ya se confirmó o se canceló');
    }
    const payload = await this.jobs.loadPayload(workspaceId, job);
    const mapping = this.jobs.validateMapping(payload, dto.hasHeaderRow, dto.columns);
    const preview = await this.jobs.buildPreview(workspaceId, actor, payload, mapping);

    // Compare-and-set: si otra petición confirmó o canceló entretanto, no se pisa su estado.
    const { count } = await this.prisma.patientImportJob.updateMany({
      where: { id, workspaceId, importerId: actor.sub, status: { in: ['UPLOADED', 'PREVIEWED'] } },
      data: {
        status: 'PREVIEWED',
        mapping: mapping as unknown as object,
        totalRows: preview.summary.total,
        errorReport: errorEntries(preview) as unknown as object,
      },
    });
    if (count === 0) throw new ConflictException('Esta importación ya se confirmó o se canceló');

    return {
      id,
      status: 'PREVIEWED' as const,
      hasHeaderRow: mapping.hasHeaderRow,
      columns: this.jobs.columnsView(payload, mapping),
      summary: preview.summary,
      rows: preview.rows,
      expiresAt: job.payloadExpiresAt,
    };
  }

  async list(workspaceId: string, actor: AuthUser) {
    await this.access.assertCanImport(actor, 'LIST');
    const jobs = await this.prisma.patientImportJob.findMany({
      where: { workspaceId, importerId: actor.sub },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: JOB_VIEW_SELECT,
    });
    return jobs.map((job) => toJobView(job));
  }

  async get(workspaceId: string, actor: AuthUser, id: string) {
    await this.access.assertCanImport(actor, 'GET');
    return this.jobs.getJobView(workspaceId, actor, id);
  }

  /** Cancela antes de confirmar (o abandona el reintento de un lote PARTIAL): borra el fichero. */
  async cancel(workspaceId: string, actor: AuthUser, id: string) {
    await this.access.assertCanImport(actor, 'CANCEL');
    const job = await this.jobs.findOwnJob(workspaceId, actor, id);
    if (!['UPLOADED', 'PREVIEWED', 'PARTIAL'].includes(job.status)) {
      throw new ConflictException('Esta importación no se puede cancelar en su estado actual');
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.patientImportJob.updateMany({
        where: { id, workspaceId, importerId: actor.sub, status: job.status },
        data: {
          payload: null,
          payloadExpiresAt: null,
          // Un PARTIAL conserva su estado (hay pacientes creados que se pueden deshacer).
          ...(job.status === 'PARTIAL' ? {} : { status: 'CANCELLED' as const }),
        },
      });
      if (count === 0) throw new ConflictException('El estado de la importación ha cambiado; recarga');
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'PATIENT_IMPORT_CANCELLED',
          entityType: 'PatientImportJob',
          entityId: id,
          metadata: { previousStatus: job.status },
        },
      });
    });
    return this.jobs.getJobView(workspaceId, actor, id);
  }

  async errorReport(workspaceId: string, actor: AuthUser, id: string) {
    await this.access.assertCanImport(actor, 'ERROR_REPORT');
    const job = await this.jobs.findOwnJob(workspaceId, actor, id);
    const entries = Array.isArray(job.errorReport) ? (job.errorReport as unknown as ErrorReportEntry[]) : [];
    return { buffer: errorReportCsv(entries), contentType: 'text/csv; charset=utf-8', fileName: `errores-importacion-${id}.csv` };
  }

  private parse(file: UploadedFile | undefined, sheet: number): { format: ImportFormat; parsed: RawSheet } {
    try {
      if (!file?.buffer?.length) throw new ImportFileError('FILE_REQUIRED');
      if (file.size > IMPORT_LIMITS.MAX_FILE_BYTES || file.buffer.length > IMPORT_LIMITS.MAX_FILE_BYTES) {
        throw new ImportFileError('FILE_TOO_LARGE');
      }
      const extension = /\.([a-z0-9]+)$/i.exec(file.originalname ?? '')?.[1]?.toLowerCase() ?? '';
      if (isLegacyXls(file.buffer) || extension === 'xls') throw new ImportFileError('LEGACY_XLS');
      if (extension === 'xlsx') {
        if (!isZip(file.buffer)) throw new ImportFileError('INVALID_XLSX');
        return { format: 'XLSX', parsed: readXlsx(file.buffer, sheet) };
      }
      if (extension === 'csv' || extension === 'txt') {
        // Un ZIP (xlsx/ods/numbers) renombrado a .csv no es texto.
        if (isZip(file.buffer)) throw new ImportFileError('INVALID_CSV');
        return { format: 'CSV', parsed: { sheetNames: [], sheetIndex: 0, date1904: false, rows: readCsv(file.buffer) } };
      }
      throw new ImportFileError('UNSUPPORTED_FORMAT');
    } catch (error) {
      if (error instanceof ImportFileError) throw error.toHttp();
      throw error;
    }
  }
}

/** Informe de errores: solo número de fila, campo y código. Se guarda en el lote (sin datos). */
export function errorEntries(preview: Preview): ErrorReportEntry[] {
  return preview.rows.flatMap((row) =>
    row.status === 'ERROR' ? row.errors.map((e) => ({ row: row.rowNumber, field: e.field, code: e.code })) : [],
  );
}

