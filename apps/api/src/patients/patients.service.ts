import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PatientCoreService } from './patient-core.service';
import { PatientAccessService } from './patient-access.service';
import { PatientCareService } from './patient-care.service';
import { PatientTasksService } from './patient-tasks.service';
import { PatientAssessmentsService } from './patient-assessments.service';
import { PatientRecordsService } from './patient-records.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { UpdateClinicalHistoryDto } from './dto/update-clinical-history.dto';
import { CreateTherapyGoalDto } from './dto/create-therapy-goal.dto';
import { UpdateTherapyGoalDto } from './dto/update-therapy-goal.dto';
import { CreateTherapeuticTaskDto } from './dto/create-therapeutic-task.dto';
import { UpdateTherapeuticTaskDto } from './dto/update-therapeutic-task.dto';
import { CreateTaskTemplateDto, UpdateTaskTemplateDto } from './dto/task-template.dto';
import { CreateClinicalAssessmentDto } from './dto/create-clinical-assessment.dto';
import { CreatePatientDocumentDto } from './dto/create-patient-document.dto';
import { CreateConsentRecordDto, UpdateConsentRecordDto } from './dto/create-consent-record.dto';
import { CreateClinicalReportDto, UpdateClinicalReportDto } from './dto/create-clinical-report.dto';

@Injectable()
export class PatientsService extends PatientCoreService {
  private readonly care: PatientCareService;
  private readonly tasks: PatientTasksService;
  private readonly assessments: PatientAssessmentsService;
  private readonly records: PatientRecordsService;

  constructor(
    prisma: PrismaService,
    @Optional() access?: PatientAccessService,
    @Optional() care?: PatientCareService,
    @Optional() tasks?: PatientTasksService,
    @Optional() assessments?: PatientAssessmentsService,
    @Optional() records?: PatientRecordsService,
  ) {
    super(prisma);
    const patientAccess = access ?? new PatientAccessService(prisma);
    this.care = care ?? new PatientCareService(prisma, patientAccess);
    this.tasks = tasks ?? new PatientTasksService(prisma, patientAccess);
    this.assessments = assessments ?? new PatientAssessmentsService(prisma, patientAccess);
    this.records = records ?? new PatientRecordsService(prisma, patientAccess);
  }

  async getClinicalHistory(workspaceId: string, actor: AuthUser, patientId: string){
    return this.care.getClinicalHistory(workspaceId, actor, patientId);
  }

  async updateClinicalHistory(workspaceId: string, actor: AuthUser, patientId: string, dto: UpdateClinicalHistoryDto){
    return this.care.updateClinicalHistory(workspaceId, actor, patientId, dto);
  }

  async getTherapyGoals(workspaceId: string, actor: AuthUser, patientId: string){
    return this.care.getTherapyGoals(workspaceId, actor, patientId);
  }

  async createTherapyGoal(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateTherapyGoalDto){
    return this.care.createTherapyGoal(workspaceId, actor, patientId, dto);
  }

  async updateTherapyGoal(workspaceId: string, actor: AuthUser, patientId: string, goalId: string, dto: UpdateTherapyGoalDto){
    return this.care.updateTherapyGoal(workspaceId, actor, patientId, goalId, dto);
  }

  async deleteTherapyGoal(workspaceId: string, actor: AuthUser, patientId: string, goalId: string){
    return this.care.deleteTherapyGoal(workspaceId, actor, patientId, goalId);
  }

  async getTaskTemplates(workspaceId: string, actor: AuthUser){
    return this.tasks.getTaskTemplates(workspaceId, actor);
  }

  async createTaskTemplate(workspaceId: string, actor: AuthUser, dto: CreateTaskTemplateDto){
    return this.tasks.createTaskTemplate(workspaceId, actor, dto);
  }

  async updateTaskTemplate(workspaceId: string, actor: AuthUser, templateId: string, dto: UpdateTaskTemplateDto){
    return this.tasks.updateTaskTemplate(workspaceId, actor, templateId, dto);
  }

  async getTherapeuticTasks(workspaceId: string, actor: AuthUser, patientId: string){
    return this.tasks.getTherapeuticTasks(workspaceId, actor, patientId);
  }

  async createTherapeuticTask(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateTherapeuticTaskDto){
    return this.tasks.createTherapeuticTask(workspaceId, actor, patientId, dto);
  }

  async updateTherapeuticTask(workspaceId:string, actor:AuthUser, patientId:string, taskId:string, dto:UpdateTherapeuticTaskDto){
    return this.tasks.updateTherapeuticTask(workspaceId, actor, patientId, taskId, dto);
  }

  async deleteTherapeuticTask(workspaceId:string,actor:AuthUser,patientId:string,taskId:string){
    return this.tasks.deleteTherapeuticTask(workspaceId, actor, patientId, taskId);
  }

  async getTimeline(workspaceId: string, actor: AuthUser, patientId: string){
    return this.tasks.getTimeline(workspaceId, actor, patientId);
  }

  async getAssessmentCatalog(workspaceId: string, actor: AuthUser, patientId: string){
    return this.assessments.getAssessmentCatalog(workspaceId, actor, patientId);
  }

  async getClinicalAssessments(workspaceId: string, actor: AuthUser, patientId: string){
    return this.assessments.getClinicalAssessments(workspaceId, actor, patientId);
  }

  async createClinicalAssessment(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateClinicalAssessmentDto){
    return this.assessments.createClinicalAssessment(workspaceId, actor, patientId, dto);
  }

  async deleteClinicalAssessment(workspaceId: string, actor: AuthUser, patientId: string, assessmentId: string){
    return this.assessments.deleteClinicalAssessment(workspaceId, actor, patientId, assessmentId);
  }

  async getPatientDocuments(workspaceId: string, actor: AuthUser, patientId: string){
    return this.records.getPatientDocuments(workspaceId, actor, patientId);
  }

  async createPatientDocument(workspaceId: string, actor: AuthUser, patientId: string, dto: CreatePatientDocumentDto){
    return this.records.createPatientDocument(workspaceId, actor, patientId, dto);
  }

  async deletePatientDocument(workspaceId: string, actor: AuthUser, patientId: string, documentId: string){
    return this.records.deletePatientDocument(workspaceId, actor, patientId, documentId);
  }

  async getConsentRecords(workspaceId: string, actor: AuthUser, patientId: string){
    return this.records.getConsentRecords(workspaceId, actor, patientId);
  }

  async createConsentRecord(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateConsentRecordDto){
    return this.records.createConsentRecord(workspaceId, actor, patientId, dto);
  }

  async updateConsentRecord(workspaceId: string, actor: AuthUser, patientId: string, consentId: string, dto: UpdateConsentRecordDto){
    return this.records.updateConsentRecord(workspaceId, actor, patientId, consentId, dto);
  }

  async deleteConsentRecord(workspaceId: string, actor: AuthUser, patientId: string, consentId: string){
    return this.records.deleteConsentRecord(workspaceId, actor, patientId, consentId);
  }

  async getClinicalReports(workspaceId: string, actor: AuthUser, patientId: string){
    return this.records.getClinicalReports(workspaceId, actor, patientId);
  }

  async createClinicalReport(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateClinicalReportDto){
    return this.records.createClinicalReport(workspaceId, actor, patientId, dto);
  }

  async updateClinicalReport(workspaceId: string, actor: AuthUser, patientId: string, reportId: string, dto: UpdateClinicalReportDto){
    return this.records.updateClinicalReport(workspaceId, actor, patientId, reportId, dto);
  }

  async deleteClinicalReport(workspaceId: string, actor: AuthUser, patientId: string, reportId: string){
    return this.records.deleteClinicalReport(workspaceId, actor, patientId, reportId);
  }
}
