import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PatientAccessService } from './patient-access.service';
import { CreatePatientDocumentDto } from './dto/create-patient-document.dto';
import { CreateConsentRecordDto, UpdateConsentRecordDto } from './dto/create-consent-record.dto';
import { CreateClinicalReportDto, UpdateClinicalReportDto } from './dto/create-clinical-report.dto';

@Injectable()
export class PatientRecordsService {
  constructor(private readonly prisma: PrismaService, private readonly access: PatientAccessService) {}

  async getPatientDocuments(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    return this.prisma.patientDocument.findMany({
      where: { workspaceId, patientId }, orderBy: { createdAt: 'desc' },
      select: { id:true,title:true,type:true,description:true,fileName:true,mimeType:true,storageKey:true,createdAt:true,updatedAt:true,createdBy:{select:{id:true,firstName:true,lastName:true}} },
    });
  }

  async createPatientDocument(workspaceId: string, actor: AuthUser, patientId: string, dto: CreatePatientDocumentDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.patientDocument.create({ data: {
        workspaceId, patientId, createdById: actor.sub, title: dto.title.trim(), type: dto.type,
        description: dto.description?.trim() || null, fileName: dto.fileName?.trim() || null,
        mimeType: dto.mimeType?.trim() || null, storageKey: dto.storageKey?.trim() || null,
      }});
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'PATIENT_DOCUMENT_CREATED', entityType: 'PatientDocument', entityId: document.id, metadata: { patientId, type: dto.type, hasStorageReference: Boolean(dto.storageKey) } } });
      return document;
    });
  }

  async deletePatientDocument(workspaceId: string, actor: AuthUser, patientId: string, documentId: string) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const existing = await this.prisma.patientDocument.findFirst({ where: { id: documentId, patientId, workspaceId } });
    if (!existing) throw new NotFoundException('Documento no encontrado');
    await this.prisma.$transaction(async (tx) => {
      await tx.patientDocument.delete({ where: { id: documentId } });
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
    const existing = await this.prisma.consentRecord.findFirst({ where: { id: consentId, patientId, workspaceId } });
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
      const consent = await tx.consentRecord.update({ where: { id: consentId }, data });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CONSENT_RECORD_UPDATED', entityType: 'ConsentRecord', entityId: consentId, metadata: { patientId, updatedFields: Object.keys(dto), previousStatus: existing.status, newStatus: consent.status } } });
      return consent;
    });
  }

  async deleteConsentRecord(workspaceId: string, actor: AuthUser, patientId: string, consentId: string) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const existing = await this.prisma.consentRecord.findFirst({ where: { id: consentId, patientId, workspaceId } });
    if (!existing) throw new NotFoundException('Consentimiento no encontrado');
    if (existing.status !== 'PENDING') throw new BadRequestException('Los consentimientos firmados, revocados o caducados no se eliminan; conserva la trazabilidad');
    await this.prisma.$transaction(async (tx) => {
      await tx.consentRecord.delete({ where: { id: consentId } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CONSENT_RECORD_DELETED', entityType: 'ConsentRecord', entityId: consentId, metadata: { patientId, type: existing.type, status: existing.status } } });
    });
    return { success: true };
  }

  async getClinicalReports(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    return this.prisma.clinicalReport.findMany({ where: { workspaceId, patientId }, orderBy: { updatedAt: 'desc' } });
  }

  async createClinicalReport(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateClinicalReportDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    return this.prisma.$transaction(async (tx) => {
      const status = dto.status ?? 'DRAFT';
      const report = await tx.clinicalReport.create({ data: {
        workspaceId, patientId, createdById: actor.sub, title: dto.title.trim(), type: dto.type,
        status, content: dto.content.trim(), finalizedAt: status === 'FINAL' ? new Date() : null,
      }});
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_REPORT_CREATED', entityType: 'ClinicalReport', entityId: report.id, metadata: { patientId, type: dto.type, status } } });
      return report;
    });
  }

  async updateClinicalReport(workspaceId: string, actor: AuthUser, patientId: string, reportId: string, dto: UpdateClinicalReportDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const existing = await this.prisma.clinicalReport.findFirst({ where: { id: reportId, patientId, workspaceId } });
    if (!existing) throw new NotFoundException('Informe no encontrado');
    if (existing.status === 'FINAL' && dto.status !== 'VOID') throw new BadRequestException('Un informe final solo puede anularse; crea una nueva versión para modificar su contenido');
    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.content !== undefined) data.content = dto.content.trim();
    if (dto.status !== undefined) { data.status = dto.status; data.finalizedAt = dto.status === 'FINAL' ? new Date() : existing.finalizedAt; }
    return this.prisma.$transaction(async (tx) => {
      const report = await tx.clinicalReport.update({ where: { id: reportId }, data });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_REPORT_UPDATED', entityType: 'ClinicalReport', entityId: reportId, metadata: { patientId, updatedFields: Object.keys(dto), previousStatus: existing.status, newStatus: report.status } } });
      return report;
    });
  }

  async deleteClinicalReport(workspaceId: string, actor: AuthUser, patientId: string, reportId: string) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const existing = await this.prisma.clinicalReport.findFirst({ where: { id: reportId, patientId, workspaceId } });
    if (!existing) throw new NotFoundException('Informe no encontrado');
    if (existing.status === 'FINAL') throw new BadRequestException('Los informes finales no se eliminan: deben anularse para conservar la trazabilidad');
    await this.prisma.$transaction(async (tx) => {
      await tx.clinicalReport.delete({ where: { id: reportId } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_REPORT_DELETED', entityType: 'ClinicalReport', entityId: reportId, metadata: { patientId, type: existing.type } } });
    });
    return { success: true };
  }
}
