import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PatientAccessService } from './patient-access.service';
import { UpdateClinicalHistoryDto } from './dto/update-clinical-history.dto';
import { CreateTherapyGoalDto } from './dto/create-therapy-goal.dto';
import { UpdateTherapyGoalDto } from './dto/update-therapy-goal.dto';

@Injectable()
export class PatientCareService {
  constructor(private readonly prisma: PrismaService, private readonly access: PatientAccessService) {}

  async getClinicalHistory(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    const history = await this.prisma.clinicalHistory.findUnique({ where: { patientId } });
    return history ?? { patientId, reasonForConsultation: null, currentProblem: null, personalHistory: null, familyHistory: null, medicalHistory: null, currentMedication: null, primaryDiagnosis: null, riskFactors: null, protectiveFactors: null, clinicalObservations: null, createdAt: null, updatedAt: null };
  }

  async updateClinicalHistory(workspaceId: string, actor: AuthUser, patientId: string, dto: UpdateClinicalHistoryDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const clean = Object.fromEntries(Object.entries(dto).map(([k,v]) => [k, typeof v === 'string' ? v.trim() || null : v]));
    return this.prisma.$transaction(async tx => {
      const saved = await tx.clinicalHistory.upsert({ where: { patientId }, create: { patientId, ...clean }, update: clean });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CLINICAL_HISTORY_UPDATED', entityType: 'ClinicalHistory', entityId: saved.id, metadata: { patientId, updatedFields: Object.keys(dto) } } });
      return saved;
    });
  }

  async getTherapyGoals(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    return this.prisma.therapyGoal.findMany({ where: { patientId }, orderBy: [{ status: 'asc' }, { priority: 'asc' }, { createdAt: 'desc' }] });
  }

  async createTherapyGoal(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateTherapyGoalDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    return this.prisma.$transaction(async tx => {
      const goal = await tx.therapyGoal.create({ data: { patientId, title: dto.title.trim(), description: dto.description?.trim() || null, targetDate: dto.targetDate ? new Date(dto.targetDate) : null, priority: dto.priority ?? 2 } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'THERAPY_GOAL_CREATED', entityType: 'TherapyGoal', entityId: goal.id, metadata: { patientId } } });
      return goal;
    });
  }

  async updateTherapyGoal(workspaceId: string, actor: AuthUser, patientId: string, goalId: string, dto: UpdateTherapyGoalDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const existing = await this.prisma.therapyGoal.findFirst({ where: { id: goalId, patientId } });
    if (!existing) throw new NotFoundException('Objetivo terapéutico no encontrado');
    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description.trim() || null;
    if (dto.targetDate !== undefined) data.targetDate = dto.targetDate ? new Date(dto.targetDate) : null;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.status !== undefined) { data.status = dto.status; data.achievedAt = dto.status === 'ACHIEVED' ? new Date() : null; }
    return this.prisma.$transaction(async tx => {
      const goal = await tx.therapyGoal.update({ where: { id: goalId }, data });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'THERAPY_GOAL_UPDATED', entityType: 'TherapyGoal', entityId: goalId, metadata: { patientId, updatedFields: Object.keys(dto) } } });
      return goal;
    });
  }

  async deleteTherapyGoal(workspaceId: string, actor: AuthUser, patientId: string, goalId: string) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const existing = await this.prisma.therapyGoal.findFirst({ where: { id: goalId, patientId } });
    if (!existing) throw new NotFoundException('Objetivo terapéutico no encontrado');
    await this.prisma.$transaction(async tx => {
      await tx.therapyGoal.delete({ where: { id: goalId } });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'THERAPY_GOAL_DELETED', entityType: 'TherapyGoal', entityId: goalId, metadata: { patientId } } });
    });
    return { success: true };
  }
}
