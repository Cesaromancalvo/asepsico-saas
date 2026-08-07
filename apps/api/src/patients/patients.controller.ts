import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { ListPatientsQueryDto } from './dto/list-patients-query.dto';
import { ChangeStatusDto } from './dto/change-status.dto';
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
import { PatientsService } from './patients.service';

@ApiTags('patients') @ApiBearerAuth() @UseGuards(JwtAuthGuard, CsrfGuard) @Controller('patients')
export class PatientsController {
  constructor(private patients: PatientsService) {}

  @Get() list(@CurrentUser() user: AuthUser, @Query() query: ListPatientsQueryDto) {
    return this.patients.list(user.workspaceId, user, query);
  }

  @Get(':id') get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.patients.get(user.workspaceId, user, id);
  }

  @Get(':id/history') getHistory(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.patients.getClinicalHistory(user.workspaceId, user, id);
  }

  @Patch(':id/history') updateHistory(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateClinicalHistoryDto,
  ) {
    return this.patients.updateClinicalHistory(user.workspaceId, user, id, dto);
  }

  @Get(':id/goals') getGoals(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.patients.getTherapyGoals(user.workspaceId, user, id);
  }

  @Post(':id/goals') createGoal(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateTherapyGoalDto,
  ) {
    return this.patients.createTherapyGoal(user.workspaceId, user, id, dto);
  }

  @Patch(':id/goals/:goalId') updateGoal(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('goalId') goalId: string,
    @Body() dto: UpdateTherapyGoalDto,
  ) {
    return this.patients.updateTherapyGoal(user.workspaceId, user, id, goalId, dto);
  }

  @Delete(':id/goals/:goalId') deleteGoal(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('goalId') goalId: string,
  ) {
    return this.patients.deleteTherapyGoal(user.workspaceId, user, id, goalId);
  }


  @Get('task-templates/library') getTaskTemplates(@CurrentUser() user: AuthUser) { return this.patients.getTaskTemplates(user.workspaceId, user); }
  @Post('task-templates/library') createTaskTemplate(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskTemplateDto) { return this.patients.createTaskTemplate(user.workspaceId, user, dto); }
  @Patch('task-templates/library/:templateId') updateTaskTemplate(@CurrentUser() user: AuthUser, @Param('templateId') templateId: string, @Body() dto: UpdateTaskTemplateDto) { return this.patients.updateTaskTemplate(user.workspaceId, user, templateId, dto); }

  @Get(':id/tasks') getTasks(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.patients.getTherapeuticTasks(user.workspaceId, user, id);
  }

  @Post(':id/tasks') createTask(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateTherapeuticTaskDto,
  ) {
    return this.patients.createTherapeuticTask(user.workspaceId, user, id, dto);
  }

  @Patch(':id/tasks/:taskId') updateTask(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: UpdateTherapeuticTaskDto,
  ) {
    return this.patients.updateTherapeuticTask(user.workspaceId, user, id, taskId, dto);
  }

  @Delete(':id/tasks/:taskId') deleteTask(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('taskId') taskId: string,
  ) {
    return this.patients.deleteTherapeuticTask(user.workspaceId, user, id, taskId);
  }


  @Get(':id/assessments/catalog') getAssessmentCatalog(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.patients.getAssessmentCatalog(user.workspaceId, user, id);
  }

  @Get(':id/assessments') getAssessments(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.patients.getClinicalAssessments(user.workspaceId, user, id);
  }

  @Post(':id/assessments') createAssessment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateClinicalAssessmentDto,
  ) {
    return this.patients.createClinicalAssessment(user.workspaceId, user, id, dto);
  }

  @Delete(':id/assessments/:assessmentId') deleteAssessment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('assessmentId') assessmentId: string,
  ) {
    return this.patients.deleteClinicalAssessment(user.workspaceId, user, id, assessmentId);
  }

  @Get(':id/documents') getDocuments(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.patients.getPatientDocuments(user.workspaceId, user, id);
  }

  @Post(':id/documents') createDocument(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreatePatientDocumentDto) {
    return this.patients.createPatientDocument(user.workspaceId, user, id, dto);
  }

  @Delete(':id/documents/:documentId') deleteDocument(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('documentId') documentId: string) {
    return this.patients.deletePatientDocument(user.workspaceId, user, id, documentId);
  }

  @Get(':id/consents') getConsents(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.patients.getConsentRecords(user.workspaceId, user, id);
  }

  @Post(':id/consents') createConsent(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateConsentRecordDto) {
    return this.patients.createConsentRecord(user.workspaceId, user, id, dto);
  }

  @Patch(':id/consents/:consentId') updateConsent(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('consentId') consentId: string, @Body() dto: UpdateConsentRecordDto) {
    return this.patients.updateConsentRecord(user.workspaceId, user, id, consentId, dto);
  }

  @Delete(':id/consents/:consentId') deleteConsent(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('consentId') consentId: string) {
    return this.patients.deleteConsentRecord(user.workspaceId, user, id, consentId);
  }

  @Get(':id/reports') getReports(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.patients.getClinicalReports(user.workspaceId, user, id);
  }

  @Post(':id/reports') createReport(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateClinicalReportDto) {
    return this.patients.createClinicalReport(user.workspaceId, user, id, dto);
  }

  @Patch(':id/reports/:reportId') updateReport(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('reportId') reportId: string, @Body() dto: UpdateClinicalReportDto) {
    return this.patients.updateClinicalReport(user.workspaceId, user, id, reportId, dto);
  }

  @Delete(':id/reports/:reportId') deleteReport(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('reportId') reportId: string) {
    return this.patients.deleteClinicalReport(user.workspaceId, user, id, reportId);
  }

  @Get(':id/timeline') getTimeline(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.patients.getTimeline(user.workspaceId, user, id);
  }

  @Post() create(@CurrentUser() user: AuthUser, @Body() dto: CreatePatientDto) {
    return this.patients.create(user.workspaceId, user, dto);
  }

  @Patch(':id') update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdatePatientDto) {
    return this.patients.update(user.workspaceId, user, id, dto);
  }

  @Patch(':id/status') changeStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ChangeStatusDto) {
    return this.patients.changeStatus(user.workspaceId, user, id, dto.status);
  }

  @Post(':id/restore') restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.patients.restore(user.workspaceId, user, id);
  }

  @Delete(':id') archive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.patients.archive(user.workspaceId, user, id);
  }
}
