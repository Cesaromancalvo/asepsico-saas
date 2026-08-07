import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PatientAccessService } from './patient-access.service';
import { CreateTherapeuticTaskDto } from './dto/create-therapeutic-task.dto';
import { UpdateTherapeuticTaskDto, TherapeuticTaskStatusValue } from './dto/update-therapeutic-task.dto';
import { CreateTaskTemplateDto, UpdateTaskTemplateDto } from './dto/task-template.dto';

@Injectable()
export class PatientTasksService {
  constructor(private readonly prisma: PrismaService, private readonly access: PatientAccessService) {}

  private assertTaskTransition(from: TherapeuticTaskStatusValue, to: TherapeuticTaskStatusValue) {
    const allowed: Record<TherapeuticTaskStatusValue, TherapeuticTaskStatusValue[]> = {
      DRAFT:['PENDING','CANCELLED'], PENDING:['IN_PROGRESS','CANCELLED'], IN_PROGRESS:['SUBMITTED','CANCELLED'],
      SUBMITTED:['CHANGES_REQUESTED','COMPLETED','CANCELLED'], CHANGES_REQUESTED:['IN_PROGRESS','SUBMITTED','CANCELLED'],
      COMPLETED:['IN_PROGRESS'], CANCELLED:[]
    };
    if (from === to) return;
    if (!allowed[from]?.includes(to)) throw new BadRequestException(`Transición de tarea no permitida: ${from} → ${to}`);
  }

  async getTaskTemplates(workspaceId: string, actor: AuthUser) {
    if (!['OWNER','ADMIN','THERAPIST'].includes(actor.role)) throw new ForbiddenException();
    return (this.prisma as any).therapeuticTaskTemplate.findMany({ where:{workspaceId,isActive:true}, orderBy:{title:'asc'} });
  }

  async createTaskTemplate(workspaceId: string, actor: AuthUser, dto: CreateTaskTemplateDto) {
    if (!['OWNER','ADMIN','THERAPIST'].includes(actor.role)) throw new ForbiddenException();
    const template=await (this.prisma as any).therapeuticTaskTemplate.create({data:{workspaceId,createdById:actor.sub,title:dto.title.trim(),instructions:dto.instructions?.trim()||null,category:dto.category?.trim()||null}});
    await this.prisma.auditLog.create({data:{workspaceId,actorId:actor.sub,action:'TASK_TEMPLATE_CREATED',entityType:'TherapeuticTaskTemplate',entityId:template.id,metadata:{}}});
    return template;
  }

  async updateTaskTemplate(workspaceId: string, actor: AuthUser, templateId: string, dto: UpdateTaskTemplateDto) {
    if (!['OWNER','ADMIN','THERAPIST'].includes(actor.role)) throw new ForbiddenException();
    const current=await (this.prisma as any).therapeuticTaskTemplate.findFirst({where:{id:templateId,workspaceId}});
    if(!current) throw new NotFoundException('Plantilla no encontrada');
    const data:any={...dto}; if(dto.title!==undefined)data.title=dto.title.trim(); if(dto.instructions!==undefined)data.instructions=dto.instructions.trim()||null; if(dto.category!==undefined)data.category=dto.category.trim()||null;
    return (this.prisma as any).therapeuticTaskTemplate.update({where:{id:templateId},data});
  }

  async getTherapeuticTasks(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    return this.prisma.therapeuticTask.findMany({ where:{patientId}, orderBy:[{updatedAt:'desc'}], include:{therapyGoal:{select:{id:true,title:true,status:true}},session:{select:{id:true,startsAt:true,status:true,type:true}}} });
  }

  async createTherapeuticTask(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateTherapeuticTaskDto) {
    const patient=await this.access.assertPatientClinicalAccess(workspaceId,actor,patientId);
    if(patient.status==='ARCHIVED') throw new BadRequestException('El paciente está archivado');
    if(dto.therapyGoalId && !(await this.prisma.therapyGoal.findFirst({where:{id:dto.therapyGoalId,patientId}}))) throw new BadRequestException('El objetivo seleccionado no pertenece al paciente');
    const status:any=dto.saveAsDraft?'DRAFT':'PENDING';
    return this.prisma.$transaction(async tx=>{
      const task=await tx.therapeuticTask.create({data:{patientId,title:dto.title.trim(),instructions:dto.instructions?.trim()||null,dueDate:dto.dueDate?new Date(dto.dueDate):null,therapyGoalId:dto.therapyGoalId||null,sessionId:dto.sessionId||null,status,assignedAt:dto.saveAsDraft?null:new Date()}});
      await tx.auditLog.create({data:{workspaceId,actorId:actor.sub,action:dto.saveAsDraft?'THERAPEUTIC_TASK_DRAFTED':'THERAPEUTIC_TASK_ASSIGNED',entityType:'TherapeuticTask',entityId:task.id,metadata:{patientId}}}); return task;
    });
  }

  async updateTherapeuticTask(workspaceId:string, actor:AuthUser, patientId:string, taskId:string, dto:UpdateTherapeuticTaskDto){
    const patient=await this.access.assertPatientClinicalAccess(workspaceId,actor,patientId); if(patient.status==='ARCHIVED')throw new BadRequestException('El paciente está archivado');
    const existing:any=await this.prisma.therapeuticTask.findFirst({where:{id:taskId,patientId}}); if(!existing)throw new NotFoundException('Tarea terapéutica no encontrada');
    if(dto.status)this.assertTaskTransition(existing.status,dto.status);
    const data:any={}; for(const k of ['title','instructions','clinicianNotes','reviewComment','therapyGoalId','sessionId']) if((dto as any)[k]!==undefined)data[k]=typeof (dto as any)[k]==='string'?((dto as any)[k].trim()||null):(dto as any)[k];
    if(dto.dueDate!==undefined)data.dueDate=dto.dueDate?new Date(dto.dueDate):null;
    if(dto.status){data.status=dto.status; const now=new Date(); if(dto.status==='PENDING')data.assignedAt=now; if(dto.status==='IN_PROGRESS')data.startedAt=now; if(dto.status==='CHANGES_REQUESTED'||dto.status==='COMPLETED')data.reviewedAt=now; if(dto.status==='COMPLETED')data.completedAt=now;}
    return this.prisma.$transaction(async tx=>{
      const task=await tx.therapeuticTask.update({where:{id:taskId},data});
      await tx.auditLog.create({data:{workspaceId,actorId:actor.sub,action:'THERAPEUTIC_TASK_UPDATED',entityType:'TherapeuticTask',entityId:taskId,metadata:{patientId,from:existing.status,to:dto.status||existing.status,updatedFields:Object.keys(dto)}}});
      return task;
    });
  }

  async deleteTherapeuticTask(workspaceId:string,actor:AuthUser,patientId:string,taskId:string){
    await this.access.assertPatientClinicalAccess(workspaceId,actor,patientId); const existing:any=await this.prisma.therapeuticTask.findFirst({where:{id:taskId,patientId}}); if(!existing)throw new NotFoundException('Tarea terapéutica no encontrada');
    if(existing.status!=='DRAFT') throw new BadRequestException('Solo se pueden eliminar borradores. Cancela la tarea para conservar el historial.');
    await this.prisma.$transaction(async tx=>{await tx.therapeuticTask.delete({where:{id:taskId}});await tx.auditLog.create({data:{workspaceId,actorId:actor.sub,action:'THERAPEUTIC_TASK_DRAFT_DELETED',entityType:'TherapeuticTask',entityId:taskId,metadata:{patientId}}});}); return {success:true};
  }

  async getTimeline(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    const [patient, history, goals, tasks, processes, sessions, assessments, documents, consents, reports, resourceShares] = await Promise.all([
      this.prisma.patient.findFirst({ where: { id: patientId, workspaceId } }),
      this.prisma.clinicalHistory.findUnique({ where: { patientId } }),
      this.prisma.therapyGoal.findMany({ where: { patientId } }),
      this.prisma.therapeuticTask.findMany({ where: { patientId } }),
      this.prisma.clinicalProcess.findMany({ where: { workspaceId, patientId, ...(actor.role === 'THERAPIST' ? { therapistId: actor.sub } : {}) }, select: { id:true,title:true,status:true,startedAt:true } }),
      this.prisma.session.findMany({ where: { workspaceId, patientId, ...(actor.role === 'THERAPIST' ? { therapistId: actor.sub } : {}) }, select: { id:true,startsAt:true,status:true,type:true } }),
      this.prisma.clinicalAssessment.findMany({ where: { patientId }, select: { id:true,scaleName:true,totalScore:true,severity:true,administeredAt:true } }),
      this.prisma.patientDocument.findMany({ where: { patientId, workspaceId }, select: { id:true,title:true,type:true,createdAt:true } }),
      this.prisma.consentRecord.findMany({ where: { patientId, workspaceId }, select: { id:true,title:true,status:true,updatedAt:true } }),
      this.prisma.clinicalReport.findMany({ where: { patientId, workspaceId }, select: { id:true,title:true,status:true,updatedAt:true } }),
      (this.prisma as any).resourceShare.findMany({ where: { patientId, workspaceId, revokedAt: null, resource: { archivedAt: null } }, select: { id:true, sharedAt:true, resource:{ select:{ title:true,category:true } } } }),
    ]);
    const events: any[] = [{ id:`patient-${patient!.id}`, type:'PATIENT_CREATED', date:patient!.createdAt, title:'Paciente registrado', description:'Se creó la ficha del paciente.' }];
    for (const process of processes) events.push({ id:`process-${process.id}`, type:'PROCESS', date:process.startedAt, title:`Proceso: ${process.title}`, description:'Evento del proceso terapéutico.', status:process.status });
    for (const session of sessions) events.push({ id:`session-${session.id}`, type:'SESSION', date:session.startsAt, title:session.status === 'COMPLETED' ? 'Sesión completada' : session.status === 'CANCELLED' ? 'Sesión cancelada' : 'Sesión programada', description:session.type.replaceAll('_',' '), status:session.status, href:`/agenda/${session.id}` });
    if (history?.updatedAt) events.push({ id:`history-${history.id}`, type:'HISTORY', date:history.updatedAt, title:'Historia clínica actualizada', description:'Se guardaron cambios en la historia clínica.' });
    for (const goal of goals) events.push({ id:`goal-${goal.id}`, type:'GOAL', date:goal.achievedAt || goal.updatedAt, title:goal.status === 'ACHIEVED' ? `Objetivo alcanzado: ${goal.title}` : `Objetivo terapéutico: ${goal.title}`, description:goal.description || 'Objetivo añadido al plan terapéutico.', status:goal.status });
    for (const task of tasks) { const taskTitle=task.status==='SUBMITTED'?`Tarea entregada: ${task.title}`:task.status==='CHANGES_REQUESTED'?`Cambios solicitados: ${task.title}`:task.status==='COMPLETED'?`Tarea completada: ${task.title}`:`Tarea terapéutica: ${task.title}`; events.push({ id:`task-${task.id}`, type:'TASK', date:(task as any).submittedAt || task.completedAt || task.updatedAt, title:taskTitle, description:(task as any).reviewComment || task.instructions || 'Tarea añadida al seguimiento entre sesiones.', status:task.status, href:`/patients/${patientId}/tasks` }); }
    for (const assessment of assessments) events.push({ id:`assessment-${assessment.id}`, type:'ASSESSMENT', date:assessment.administeredAt, title:`${assessment.scaleName}: ${assessment.totalScore} puntos`, description:assessment.severity, href:`/patients/${patientId}/assessments` });
    for (const document of documents) events.push({ id:`document-${document.id}`, type:'DOCUMENT', date:document.createdAt, title:`Documento: ${document.title}`, description:document.type.replaceAll('_',' '), href:`/patients/${patientId}/documents` });
    for (const consent of consents) events.push({ id:`consent-${consent.id}`, type:'CONSENT', date:consent.updatedAt, title:`Consentimiento: ${consent.title}`, description:consent.status, href:`/patients/${patientId}/documents` });
    for (const report of reports) events.push({ id:`report-${report.id}`, type:'REPORT', date:report.updatedAt, title:`Informe: ${report.title}`, description:report.status, href:`/patients/${patientId}/documents` });
    for (const share of resourceShares) events.push({ id:`resource-${share.id}`, type:'RESOURCE', date:share.sharedAt, title:`Recurso compartido: ${share.resource.title}`, description:share.resource.category.replaceAll('_',' '), href:`/patients/${patientId}/resources` });
    return events.sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }
}
