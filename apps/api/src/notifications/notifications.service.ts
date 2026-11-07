import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { UpdateNotificationPreferencesDto, UpdateStaffEmailPreferencesDto } from './dto/notification.dto';
import { KIND_FIELD, kindAllowedForRole, STAFF_EMAIL_KINDS, staffEmailPreferenceView } from './email/staff-email-preferences';
import { sendDeferredNoticeReminders } from '../exceptional-access/exceptional-access-register.service';
import { routeToActiveMembers } from '../workspace-members/notification-recipients.util';
import { enrichAppointmentChanges } from './appointment-change-notice.util';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma:PrismaService) {}
  private p() { return this.prisma as any; }

  async listProfessional(actor:any, unreadOnly=false) {
    const rows=await this.p().notification.findMany({
      where:{ workspaceId:actor.workspaceId, audience:'PROFESSIONAL', userId:actor.sub, ...(unreadOnly?{status:{not:'READ'}}:{}) },
      orderBy:{ createdAt:'desc' }, take:100,
      // patientId y metadata solo se leen para componer los avisos de cambio de cita; no se devuelven.
      select:{ id:true,type:true,title:true,body:true,actionUrl:true,status:true,scheduledAt:true,sentAt:true,readAt:true,createdAt:true,patientId:true,metadata:true },
    });
    return enrichAppointmentChanges(this.prisma,actor,rows);
  }
  /** Contador para la campana: avisos sin leer del propio usuario en su espacio. */
  async unreadCountProfessional(actor:any) {
    const unread=await this.p().notification.count({ where:{ workspaceId:actor.workspaceId, audience:'PROFESSIONAL', userId:actor.sub, status:{not:'READ'} } });
    return { unread };
  }
  /** Marca como leídos todos los avisos del propio usuario en su espacio. */
  async markAllProfessionalRead(actor:any) {
    const result=await this.p().notification.updateMany({ where:{ workspaceId:actor.workspaceId, audience:'PROFESSIONAL', userId:actor.sub, status:{not:'READ'} }, data:{status:'READ',readAt:new Date()} });
    return { ok:true, updated:result.count };
  }
  async listPatient(portal:any) {
    await this.assertPortal(portal);
    return this.p().notification.findMany({
      where:{ workspaceId:portal.workspaceId, audience:'PATIENT', patientId:portal.patientId }, orderBy:{createdAt:'desc'}, take:100,
      select:{ id:true,type:true,title:true,body:true,actionUrl:true,status:true,scheduledAt:true,sentAt:true,readAt:true,createdAt:true },
    });
  }
  async getProfessionalPreferences(actor:any) {
    return (await this.p().notificationPreference.findUnique({where:{workspaceId_userId:{workspaceId:actor.workspaceId,userId:actor.sub}}})) ?? this.defaults();
  }
  /** Preferencias propias en el espacio actual. AuditLog en la misma transacción (antes/después, sin direcciones). */
  async updateProfessionalPreferences(actor:any,dto:UpdateNotificationPreferencesDto) {
    const key={workspaceId_userId:{workspaceId:actor.workspaceId,userId:actor.sub}};
    return this.prisma.$transaction(async(tx:any)=>{
      const before=await tx.notificationPreference.findUnique({where:key});
      const saved=await tx.notificationPreference.upsert({ where:key, create:{workspaceId:actor.workspaceId,userId:actor.sub,...dto}, update:dto });
      await tx.auditLog.create({data:{workspaceId:actor.workspaceId,actorId:actor.sub,action:'NOTIFICATION_PREFERENCES_UPDATED',entityType:'NotificationPreference',entityId:saved.id,metadata:{source:'STAFF',...diff(before,saved,Object.keys(dto))}}});
      return saved;
    });
  }
  /** N4: avisos por email del propio usuario en el espacio actual (valor efectivo y si es el defecto). */
  async getStaffEmailPreferences(actor:any) {
    const pref=await this.p().notificationPreference.findUnique({where:{workspaceId_userId:{workspaceId:actor.workspaceId,userId:actor.sub}},select:{emailAppointmentRequests:true,emailPatientCancellations:true,emailTaskSubmitted:true}});
    return { workspaceId:actor.workspaceId, preferences:staffEmailPreferenceView(pref,actor.role) };
  }
  /** N4: solo las propias (no hay userId en la ruta). ASSISTANT no puede encender tareas (403). */
  async updateStaffEmailPreferences(actor:any,dto:UpdateStaffEmailPreferencesDto) {
    const changes=STAFF_EMAIL_KINDS.filter((k)=>typeof dto[k]==='boolean');
    for (const kind of changes) if (!kindAllowedForRole(kind,actor.role)) throw new ForbiddenException('Tu rol no puede recibir este aviso');
    const data=Object.fromEntries(changes.map((k)=>[KIND_FIELD[k],dto[k]]));
    const key={workspaceId_userId:{workspaceId:actor.workspaceId,userId:actor.sub}};
    await this.prisma.$transaction(async(tx:any)=>{
      const before=await tx.notificationPreference.findUnique({where:key});
      const saved=await tx.notificationPreference.upsert({where:key,create:{workspaceId:actor.workspaceId,userId:actor.sub,...data},update:data});
      await tx.auditLog.create({data:{workspaceId:actor.workspaceId,actorId:actor.sub,action:'STAFF_EMAIL_PREFERENCES_UPDATED',entityType:'NotificationPreference',entityId:saved.id,metadata:{source:'STAFF',...diff(before,saved,Object.keys(data))}}});
    });
    return this.getStaffEmailPreferences(actor);
  }
  async getPatientPreferences(portal:any) {
    await this.assertPortal(portal);
    return (await this.p().notificationPreference.findUnique({where:{workspaceId_patientId:{workspaceId:portal.workspaceId,patientId:portal.patientId}}})) ?? this.defaults();
  }
  async updatePatientPreferences(portal:any,dto:UpdateNotificationPreferencesDto) {
    await this.assertPortal(portal);
    const safe = {...dto};
    // SMS no se activa si el paciente no tiene teléfono; evita falsas expectativas de entrega.
    if (safe.smsEnabled) {
      const patient=await this.prisma.patient.findFirst({where:{id:portal.patientId,workspaceId:portal.workspaceId},select:{phone:true}});
      if (!patient?.phone) safe.smsEnabled=false;
    }
    const key={workspaceId_patientId:{workspaceId:portal.workspaceId,patientId:portal.patientId}};
    return this.prisma.$transaction(async(tx:any)=>{
      const before=await tx.notificationPreference.findUnique({where:key});
      const saved=await tx.notificationPreference.upsert({where:key,create:{workspaceId:portal.workspaceId,patientId:portal.patientId,...safe},update:safe});
      await tx.auditLog.create({data:{workspaceId:portal.workspaceId,actorId:null,action:'NOTIFICATION_PREFERENCES_UPDATED',entityType:'NotificationPreference',entityId:saved.id,metadata:{source:'PORTAL',patientId:portal.patientId,accessorType:portal.accessorType??null,portalAccountId:portal.portalAccountId??null,...diff(before,saved,Object.keys(safe))}}});
      return saved;
    });
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
      this.p().therapeuticTask.findMany({where:{patient:{workspaceId:actor.workspaceId},status:{in:['PENDING','IN_PROGRESS']},dueDate:{gte:now,lte:maxHorizon}},select:{id:true,patientId:true,dueDate:true,patient:{select:{clinicalProcesses:{where:{status:'ACTIVE'},take:1,select:{therapistId:true}}}}}}),
      this.p().consentRecord.findMany({where:{workspaceId:actor.workspaceId,status:'SIGNED',expiresAt:{gte:now,lte:maxHorizon}},select:{id:true,patientId:true,expiresAt:true}}),
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
      if(pp.taskReminders&&inWindow(t.dueDate,pp.reminderHoursBefore)) add({workspaceId:actor.workspaceId,audience:'PATIENT',patientId:t.patientId,type:'TASK_DUE',title:'Tarea próxima a vencer',body:'Tienes una tarea que vence pronto. Consúltala en tu portal.',actionUrl:'/portal',dedupeKey:`task:${t.id}:patient:${pp.reminderHoursBefore}h`});
      const therapistId=t.patient?.clinicalProcesses?.[0]?.therapistId;
      if(therapistId){const up:any=prefForUser(therapistId);if(up.taskReminders&&inWindow(t.dueDate,up.reminderHoursBefore)) add({workspaceId:actor.workspaceId,audience:'PROFESSIONAL',userId:therapistId,type:'TASK_DUE',title:'Seguimiento de tarea',body:'Una tarea terapéutica vence próximamente.',actionUrl:`/patients/${t.patientId}/tasks`,dedupeKey:`task:${t.id}:therapist:${up.reminderHoursBefore}h`});}
    }
    for(const c of consents){const pp:any=prefForPatient(c.patientId);if(pp.consentReminders&&inWindow(c.expiresAt,pp.reminderHoursBefore)) add({workspaceId:actor.workspaceId,audience:'PATIENT',patientId:c.patientId,type:'CONSENT_EXPIRING',title:'Consentimiento próximo a caducar',body:'Uno de tus consentimientos caduca pronto. Consúltalo en tu portal.',actionUrl:'/portal',dedupeKey:`consent:${c.id}:patient:${pp.reminderHoursBefore}h`});}
    for(const i of invoices){const pp:any=prefForPatient(i.patientId);if(pp.invoiceReminders&&inWindow(i.dueDate,pp.reminderHoursBefore)) add({workspaceId:actor.workspaceId,audience:'PATIENT',patientId:i.patientId,type:'INVOICE_DUE',title:'Cobro pendiente',body:`El cobro ${i.invoiceNumber} tiene un saldo pendiente.`,actionUrl:'/portal',dedupeKey:`invoice:${i.id}:patient:${pp.reminderHoursBefore}h`});}
    // Recordatorios a un profesional dado de baja sin reasignar ("decidir después") → OWNER/ADMIN activos.
    const routes=await routeToActiveMembers(this.p(),actor.workspaceId,rows.filter((r)=>r.audience==='PROFESSIONAL').map((r)=>r.userId));
    const routed=rows.flatMap((r)=>{
      if(r.audience!=='PROFESSIONAL') return [r];
      const to=routes.get(r.userId)??[];
      return to.map((userId)=>userId===r.userId?r:{...r,userId,dedupeKey:`${r.dedupeKey}:to:${userId}`});
    });
    rows.length=0; rows.push(...routed);
    const result=rows.length ? await this.p().notification.createMany({data:rows,skipDuplicates:true}) : {count:0};
    // Acceso excepcional: recordatorio cada 30 días al OWNER de los avisos al titular diferidos (§3.6).
    const deferredReminders=await sendDeferredNoticeReminders(this.prisma,actor.workspaceId,now);
    await this.prisma.auditLog.create({data:{workspaceId:actor.workspaceId,actorId:actor.sub,action:'NOTIFICATION_BATCH_PROCESSED',entityType:'Notification',metadata:{candidates:rows.length,created:result.count,deferredReminders}}});
    return {candidates:rows.length,created:result.count,deferredReminders};
  }

  private defaults(){return {appointmentReminders:true,taskReminders:true,consentReminders:true,invoiceReminders:true,emailEnabled:false,smsEnabled:false,reminderHoursBefore:24};}
  private async assertPortal(portal:any){
    const account=await this.p().patientPortalAccount.findFirst({where:{id:portal.portalAccountId,patientId:portal.patientId,workspaceId:portal.workspaceId,isActive:true},select:{id:true}});
    if(!account) throw new ForbiddenException();
  }
}

/** Antes/después de los campos tocados (solo booleanos y números: las preferencias no guardan direcciones). */
function diff(before:any,after:any,fields:string[]){
  const pick=(row:any)=>Object.fromEntries(fields.map((f)=>[f,row?.[f]??null]));
  return { fields, before:pick(before), after:pick(after) };
}
