import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { decryptField, encryptField } from '../common/crypto/field-encryption';
import { PatientAccessService } from './patient-access.service';
import { assertScopedWrite } from './patient-write.util';
import { CreatePatientDocumentDto } from './dto/create-patient-document.dto';
import { CreateConsentRecordDto, UpdateConsentRecordDto } from './dto/create-consent-record.dto';
import { CreateClinicalReportDto, UpdateClinicalReportDto } from './dto/create-clinical-report.dto';

// El contenido de un informe clínico (evolución, alta, derivación, certificado) es tan
// sensible como la propia historia clínica, así que se cifra en reposo igual que el resto.
function decryptReport<T extends { content?: string | null }>(report: T): T {
  return { ...report, content: decryptField(report.content) ?? '' };
}

// description y fileName de un documento del paciente pueden llevar contenido revelador
// (una descripción narrativa, o un nombre de archivo con datos identificativos) — se
// cifran igual que el resto del contenido clínico. storageKey y mimeType se quedan tal
// cual: son referencias técnicas internas, no contenido legible por sí mismas.
function decryptDocument<T extends { description?: string | null; fileName?: string | null }>(document: T): T {
  return {
    ...document,
    description: decryptField(document.description) ?? null,
    fileName: decryptField(document.fileName) ?? null,
  };
}

@Injectable()
export class PatientRecordsService {
  constructor(private readonly prisma: PrismaService, private readonly access: PatientAccessService) {}

  async getPatientDocuments(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    const documents = await this.prisma.patientDocument.findMany({
      where: { workspaceId, patientId }, orderBy: { createdAt: 'desc' },
      select: { id:true,title:true,type:true,description:true,fileName:true,mimeType:true,storageKey:true,createdAt:true,updatedAt:true,createdBy:{select:{id:true,firstName:true,lastName:true}} },
    });
    return documents.map(decryptDocument);
  }

  async createPatientDocument(workspaceId: string, actor: AuthUser, patientId: string, dto: CreatePatientDocumentDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.patientDocument.create({ data: {
        workspaceId, patientId, createdById: actor.sub, title: dto.title.trim(), type: dto.type,
        description: encryptField(dto.description?.trim() || null), fileName: encryptField(dto.fileName?.trim() || null),
        mimeType: dto.mimeType?.trim() || null, storageKey: dto.storageKey?.trim() || null,
      }});
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'PATIENT_DOCUMENT_CREATED', entityType: 'PatientDocument', entityId: document.id, metadata: { patientId, type: dto.type, hasStorageReference: Boolean(dto.storageKey) } } });
      return decryptDocument(document);
    });
  }

  async deletePatientDocument(workspaceId: string, actor: AuthUser, patientId: string, documentId: string) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const scope = { id: documentId, patientId, workspaceId };
    const existing = await this.prisma.patientDocument.findFirst({ where: scope });
    if (!existing) throw new NotFoundException('Documento no encontrado');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.patientDocument.deleteMany({ where: scope });
      await assertScopedWrite(count, 'Documento no encontrado');
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'PATIENT_DOCUMENT_DELETED', entityType: 'PatientDocument', entityId: documentId, metadata: { patientId, type: existing.type } } });
    });
    return { success: true };
  }

  async getConsentRecords(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    return this.prisma.consentRecord.findMany({ where: { workspaceId, patientId }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }] });
  }

  async createConsentRecord(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateConsentRecordDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    if (dto.status === 'SIGNED' && !dto.signedAt) throw new BadRequestException('Indica la fecha de firma del consentimiento');
    const title = dto.title?.trim() || dto.type.replaceAll('_', ' ');
    return this.prisma.$transaction(async (tx) => {
      const consent = await tx.consentRecord.create({ data: {
        workspaceId, patientId, createdById: actor.sub, type: dto.type, title, status: dto.status,
        signedAt: dto.signedAt ? new Date(dto.signedAt) : null, expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        signedBy: dto.signedBy?.trim() || null, notes: dto.notes?.trim() || null,
      }});
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CONSENT_RECORD_CREATED', entityType: 'ConsentRecord', entityId: consent.id, metadata: { patientId, type: dto.type, status: dto.status } } });
      return consent;
    });
  }

  async updateConsentRecord(workspaceId: string, actor: AuthUser, patientId: string, consentId: string, dto: UpdateConsentRecordDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const scope = { id: consentId, patientId, workspaceId };
    const existing = await this.prisma.consentRecord.findFirst({ where: scope });
    if (!existing) throw new NotFoundException('Consentimiento no encontrado');
    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.signedAt !== undefined) data.signedAt = dto.signedAt ? new Date(dto.signedAt) : null;
    if (dto.expiresAt !== undefined) data.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (dto.signedBy !== undefined) data.signedBy = dto.signedBy.trim() || null;
    if (dto.notes !== undefined) data.notes = dto.notes.trim() || null;
    const resultingStatus = dto.status ?? existing.status;
    const resultingSignedAt = dto.signedAt !== undefined ? data.signedAt : existing.signedAt;
    if (resultingStatus === 'SIGNED' && !resultingSignedAt) throw new BadRequestException('Indica la fecha de firma del consentimiento');
    return this.prisma.$transaction(async (tx) => {
      // La validación de firma usó existing.status/signedAt: deben seguir igual al escribir.
      const { count } = await tx.consentRecord.updateMany({ where: { ...scope, status: existing.status, signedAt: existing.signedAt }, data });
      await assertScopedWrite(count, 'Consentimiento no encontrado', () => tx.consentRecord.findFirst({ where: scope, select: { id: true } }));
      const consent = (await tx.consentRecord.findFirst({ where: scope }))!;
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CONSENT_RECORD_UPDATED', entityType: 'ConsentRecord', entityId: consentId, metadata: { patientId, updatedFields: Object.keys(dto), previousStatus: existing.status, newStatus: consent.status } } });
      return consent;
    });
  }

  async deleteConsentRecord(workspaceId: string, actor: AuthUser, patientId: string, consentId: string) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const scope = { id: consentId, patientId, workspaceId };
    const existing = await this.prisma.consentRecord.findFirst({ where: scope });
    if (!existing) throw new NotFoundException('Consentimiento no encontrado');
    if (existing.status !== 'PENDING') throw new BadRequestException('Los consentimientos firmados, revocados o caducados no se eliminan; conserva la trazabilidad');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.consentRecord.deleteMany({ where: { ...scope, status: 'PENDING' } });
      await assertScopedWrite(count, 'Consentimiento no encontrado', () => tx.consentRecord.findFirst({ where: scope, select: { id: true } }));
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CONSENT_RECORD_DELETED', entityType: 'ConsentRecord', entityId: consentId, metadata: { patientId, type: existing.type, status: existing.status } } });
    });
    return { success: true };
  }

  async getClinicalReports(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    const reports = await this.prisma.clinicalReport.findMany({ where: { workspaceId, patientId }, orderBy: { updatedAt: 'desc' } });
    return reports.map(decryptReport);
  }

  async createClinicalReport(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateClinicalReportDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    return this.prisma.$transaction(async (tx) => {
      const status = dto.status ?? 'DRAFT';
      const report = await tx.clinicalReport.create({ data: {
        workspaceId, patientId, createdById: actor.sub, title: dto.title.trim(), type: dto.type,
        status, content: encryptField(dto.content.trim())!, finalizedAt: status === 'FINAL' ? new Date() : null,
      }});
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_REPORT_CREATED', entityType: 'ClinicalReport', entityId: report.id, metadata: { patientId, type: dto.type, status } } });
      return decryptReport(report);
    });
  }

  async updateClinicalReport(workspaceId: string, actor: AuthUser, patientId: string, reportId: string, dto: UpdateClinicalReportDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const scope = { id: reportId, patientId, workspaceId };
    const existing = await this.prisma.clinicalReport.findFirst({ where: scope });
    if (!existing) throw new NotFoundException('Informe no encontrado');
    if (existing.status === 'FINAL' && dto.status !== 'VOID') throw new BadRequestException('Un informe final solo puede anularse; crea una nueva versión para modificar su contenido');
    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.content !== undefined) data.content = encryptField(dto.content.trim());
    if (dto.status !== undefined) { data.status = dto.status; data.finalizedAt = dto.status === 'FINAL' ? new Date() : existing.finalizedAt; }
    return this.prisma.$transaction(async (tx) => {
      // La regla "un informe FINAL solo se anula" se validó sobre existing.status: debe seguir igual.
      const { count } = await tx.clinicalReport.updateMany({ where: { ...scope, status: existing.status }, data });
      await assertScopedWrite(count, 'Informe no encontrado', () => tx.clinicalReport.findFirst({ where: scope, select: { id: true } }));
      const report = (await tx.clinicalReport.findFirst({ where: scope }))!;
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_REPORT_UPDATED', entityType: 'ClinicalReport', entityId: reportId, metadata: { patientId, updatedFields: Object.keys(dto), previousStatus: existing.status, newStatus: report.status } } });
      return decryptReport(report);
    });
  }

  async deleteClinicalReport(workspaceId: string, actor: AuthUser, patientId: string, reportId: string) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const scope = { id: reportId, patientId, workspaceId };
    const existing = await this.prisma.clinicalReport.findFirst({ where: scope });
    if (!existing) throw new NotFoundException('Informe no encontrado');
    if (existing.status === 'FINAL') throw new BadRequestException('Los informes finales no se eliminan: deben anularse para conservar la trazabilidad');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.clinicalReport.deleteMany({ where: { ...scope, status: { not: 'FINAL' } } });
      await assertScopedWrite(count, 'Informe no encontrado', () => tx.clinicalReport.findFirst({ where: scope, select: { id: true } }));
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_REPORT_DELETED', entityType: 'ClinicalReport', entityId: reportId, metadata: { patientId, type: existing.type } } });
    });
    return { success: true };
  }
}
