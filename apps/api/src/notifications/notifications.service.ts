import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { UpdateNotificationPreferencesDto } from './dto/notification.dto';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma:PrismaService) {}
  private p() { return this.prisma as any; }

  async listProfessional(actor:any, unreadOnly=false) {
    return this.p().notification.findMany({
      where:{ workspaceId:actor.workspaceId, audience:'PROFESSIONAL', userId:actor.sub, ...(unreadOnly?{status:{not:'READ'}}:{}) },
      orderBy:{ createdAt:'desc' }, take:100,
      select:{ id:true,type:true,title:true,body:true,actionUrl:true,status:true,scheduledAt:true,sentAt:true,readAt:true,createdAt:true },
    });
  }
  async listPatient(portal:any) {
    await this.assertPortal(portal);
    return this.p().notification.findMany({
      where:{ workspaceId:portal.workspaceId, audience:'PATIENT', patientId:portal.patientId }, orderBy:{createdAt:'desc'}, take:100,
      select:{ id:true,type:true,title:true,body:true,actionUrl:true,status:true,scheduledAt:true,sentAt:true,readAt:true,createdAt:true },
    });
  }
  async getProfessionalPreferences(actor:any) {
    return (await this.p().notificationPreference.findUnique({where:{userId:actor.sub}})) ?? this.defaults();
  }
  async updateProfessionalPreferences(actor:any,dto:UpdateNotificationPreferencesDto) {
    return this.p().notificationPreference.upsert({ where:{userId:actor.sub}, create:{workspaceId:actor.workspaceId,userId:actor.sub,...dto}, update:dto });
  }
  async getPatientPreferences(portal:any) {
    await this.assertPortal(portal);
    return (await this.p().notificationPreference.findUnique({where:{patientId:portal.patientId}})) ?? this.defaults();
  }
  async updatePatientPreferences(portal:any,dto:UpdateNotificationPreferencesDto) {
    await this.assertPortal(portal);
    const safe = {...dto};
    // SMS no se activa si el paciente no tiene teléfono; evita falsas expectativas de entrega.
    if (safe.smsEnabled) {
      const patient=await this.prisma.patient.findFirst({where:{id:portal.patientId,workspaceId:portal.workspaceId},select:{phone:true}});
      if (!patient?.phone) safe.smsEnabled=false;
    }
    return this.p().notificationPreference.upsert({where:{patientId:portal.patientId},create:{workspaceId:portal.workspaceId,patientId:portal.patientId,...safe},update:safe});
  }
  async markProfessionalRead(actor:any,id:string) {
    const result=await this.p().notification.updateMany({where:{id,workspaceId:actor.workspaceId,userId:actor.sub,audience:'PROFESSIONAL'},data:{status:'READ',readAt:new Date()}});
    if (!result.count) throw new NotFoundException();
    return {ok:true};
  }
  async markPatientRead(portal:any,id:string) {
    await this.assertPortal(portal);
    const result=await this.p().notification.updateMany({where:{id,workspaceId:portal.workspaceId,patientId:portal.patientId,audience:'PATIENT'},data:{status:'READ',readAt:new Date()}});
    if (!result.count) throw new NotFoundException();
    return {ok:true};
  }

  async processDue(actor:any) {
    if (!['OWNER','ADMIN'].includes(actor.role)) throw new ForbiddenException('Solo administración puede procesar recordatorios');
    const now=new Date();
    const maxHorizon=new Date(now.getTime()+168*60*60_000);
    const [sessions,tasks,consents,invoices] = await Promise.all([
      this.prisma.session.findMany({where:{workspaceId:actor.workspaceId,status:'SCHEDULED',startsAt:{gte:now,lte:maxHorizon}},select:{id:true,patientId:true,therapistId:true,startsAt:true,type:true}}),
      this.p().therapeuticTask.findMany({where:{patient:{workspaceId:actor.workspaceId},status:{in:['PENDING','IN_PROGRESS']},dueDate:{gte:now,lte:maxHorizon}},select:{id:true,patientId:true,title:true,dueDate:true,patient:{select:{clinicalProcesses:{where:{status:'ACTIVE'},take:1,select:{therapistId:true}}}}}}),
      this.p().consentRecord.findMany({where:{workspaceId:actor.workspaceId,status:'SIGNED',expiresAt:{gte:now,lte:maxHorizon}},select:{id:true,patientId:true,title:true,expiresAt:true}}),
      this.p().invoice.findMany({where:{workspaceId:actor.workspaceId,status:{in:['ISSUED','PARTIALLY_PAID','OVERDUE']},dueDate:{gte:now,lte:maxHorizon}},select:{id:true,patientId:true,invoiceNumber:true,dueDate:true,totalCents:true,paidCents:true}}),
    ]);

    const patientIds=[...new Set([...sessions.map((x:any)=>x.patientId),...tasks.map((x:any)=>x.patientId),...consents.map((x:any)=>x.patientId),...invoices.map((x:any)=>x.patientId)])];
    const userIds=[...new Set([...sessions.map((x:any)=>x.therapistId),...tasks.map((x:any)=>x.patient?.clinicalProcesses?.[0]?.therapistId).filter(Boolean)])];
    const preferences=await this.p().notificationPreference.findMany({where:{workspaceId:actor.workspaceId,OR:[...(patientIds.length?[{patientId:{in:patientIds}}]:[]),...(userIds.length?[{userId:{in:userIds}}]:[])]}});
    const patientPrefs=new Map(preferences.filter((x:any)=>x.patientId).map((x:any)=>[x.patientId,x]));
    const userPrefs=new Map(preferences.filter((x:any)=>x.userId).map((x:any)=>[x.userId,x]));
    const prefForPatient=(id:string)=>patientPrefs.get(id)??this.defaults();
    const prefForUser=(id:string)=>userPrefs.get(id)??this.defaults();
    const inWindow=(date:Date|null|undefined,hours:number)=>Boolean(date&&date.getTime()<=now.getTime()+hours*60*60_000);

    const rows:any[]=[];
    const add=(row:any)=>rows.push({...row,status:'SENT',sentAt:now,scheduledAt:now});
    for(const s of sessions){
      const pp:any=prefForPatient(s.patientId); const up:any=prefForUser(s.therapistId);
      if(pp.appointmentReminders&&inWindow(s.startsAt,pp.reminderHoursBefore)) add({workspaceId:actor.workspaceId,audience:'PATIENT',patientId:s.patientId,type:'APPOINTMENT_REMINDER',title:'Próxima cita',body:`Tienes una sesión programada para ${s.startsAt.toISOString()}.`,actionUrl:'/portal',dedupeKey:`session:${s.id}:patient:${pp.reminderHoursBefore}h`});
      if(up.appointmentReminders&&inWindow(s.startsAt,up.reminderHoursBefore)) add({workspaceId:actor.workspaceId,audience:'PROFESSIONAL',userId:s.therapistId,type:'APPOINTMENT_REMINDER',title:'Sesión próxima',body:'Tienes una sesión programada próximamente.',actionUrl:`/agenda/${s.id}`,dedupeKey:`session:${s.id}:therapist:${up.reminderHoursBefore}h`});
    }
    for(const t of tasks){
      const pp:any=prefForPatient(t.patientId);
      if(pp.taskReminders&&inWindow(t.dueDate,pp.reminderHoursBefore)) add({workspaceId:actor.workspaceId,audience:'PATIENT',patientId:t.patientId,type:'TASK_DUE',title:'Tarea próxima a vencer',body:t.title,actionUrl:'/portal',dedupeKey:`task:${t.id}:patient:${pp.reminderHoursBefore}h`});
      const therapistId=t.patient?.clinicalProcesses?.[0]?.therapistId;
      if(therapistId){const up:any=prefForUser(therapistId);if(up.taskReminders&&inWindow(t.dueDate,up.reminderHoursBefore)) add({workspaceId:actor.workspaceId,audience:'PROFESSIONAL',userId:therapistId,type:'TASK_DUE',title:'Seguimiento de tarea',body:'Una tarea terapéutica vence próximamente.',actionUrl:`/patients/${t.patientId}/tasks`,dedupeKey:`task:${t.id}:therapist:${up.reminderHoursBefore}h`});}
    }
    for(const c of consents){const pp:any=prefForPatient(c.patientId);if(pp.consentReminders&&inWindow(c.expiresAt,pp.reminderHoursBefore)) add({workspaceId:actor.workspaceId,audience:'PATIENT',patientId:c.patientId,type:'CONSENT_EXPIRING',title:'Consentimiento próximo a caducar',body:c.title,actionUrl:'/portal',dedupeKey:`consent:${c.id}:patient:${pp.reminderHoursBefore}h`});}
    for(const i of invoices){const pp:any=prefForPatient(i.patientId);if(pp.invoiceReminders&&inWindow(i.dueDate,pp.reminderHoursBefore)) add({workspaceId:actor.workspaceId,audience:'PATIENT',patientId:i.patientId,type:'INVOICE_DUE',title:'Factura pendiente',body:`La factura ${i.invoiceNumber} tiene un saldo pendiente.`,actionUrl:'/portal',dedupeKey:`invoice:${i.id}:patient:${pp.reminderHoursBefore}h`});}
    const result=rows.length ? await this.p().notification.createMany({data:rows,skipDuplicates:true}) : {count:0};
    await this.prisma.auditLog.create({data:{workspaceId:actor.workspaceId,actorId:actor.sub,action:'NOTIFICATION_BATCH_PROCESSED',entityType:'Notification',metadata:{candidates:rows.length,created:result.count}}});
    return {candidates:rows.length,created:result.count};
  }

  private defaults(){return {appointmentReminders:true,taskReminders:true,consentReminders:true,invoiceReminders:true,emailEnabled:false,smsEnabled:false,reminderHoursBefore:24};}
  private async assertPortal(portal:any){
    const account=await this.p().patientPortalAccount.findFirst({where:{id:portal.portalAccountId,patientId:portal.patientId,workspaceId:portal.workspaceId,isActive:true},select:{id:true}});
    if(!account) throw new ForbiddenException();
  }
}
