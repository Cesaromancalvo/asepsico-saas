import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NotificationsService } from '../src/notifications/notifications.service';
import { FAKE_TEAM, fakeMembersFindMany } from './support/fake-members';
const owner:any={sub:'o1',workspaceId:'w1',role:'OWNER'};
const therapist:any={sub:'t1',workspaceId:'w1',role:'THERAPIST'};
function mock(team = FAKE_TEAM){return {workspaceMember:{findMany:fakeMembersFindMany(team)},notification:{findMany:jest.fn(),updateMany:jest.fn(),createMany:jest.fn()},notificationPreference:{findUnique:jest.fn(),findMany:jest.fn().mockResolvedValue([]),upsert:jest.fn()},patientPortalAccount:{findFirst:jest.fn()},patient:{findFirst:jest.fn()},session:{findMany:jest.fn()},therapeuticTask:{findMany:jest.fn()},consentRecord:{findMany:jest.fn()},invoice:{findMany:jest.fn()},exceptionalAccessJustification:{findMany:jest.fn().mockResolvedValue([])},auditLog:{create:jest.fn()}} as any}
describe('Notifications security and integration',()=>{
 it('scopes professional inbox to workspace and user',async()=>{const p=mock();p.notification.findMany.mockResolvedValue([]);await new NotificationsService(p).listProfessional(owner,true);expect(p.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({workspaceId:'w1',userId:'o1',audience:'PROFESSIONAL'})}))});
 it('prevents reading another user notification',async()=>{const p=mock();p.notification.updateMany.mockResolvedValue({count:0});await expect(new NotificationsService(p).markProfessionalRead(owner,'foreign')).rejects.toBeInstanceOf(NotFoundException)});
 it('only owner/admin can process reminders',async()=>{const p=mock();await expect(new NotificationsService(p).processDue(therapist)).rejects.toBeInstanceOf(ForbiddenException);expect(p.session.findMany).not.toHaveBeenCalled()});
 it('uses idempotent dedupe keys and audits a batch',async()=>{const p=mock();p.session.findMany.mockResolvedValue([{id:'s1',patientId:'p1',therapistId:'t1',startsAt:new Date(),type:'INDIVIDUAL'}]);p.therapeuticTask.findMany.mockResolvedValue([]);p.consentRecord.findMany.mockResolvedValue([]);p.invoice.findMany.mockResolvedValue([]);p.notification.createMany.mockResolvedValue({count:2});await new NotificationsService(p).processDue(owner);expect(p.notification.createMany).toHaveBeenCalledWith(expect.objectContaining({skipDuplicates:true,data:expect.arrayContaining([expect.objectContaining({dedupeKey:'session:s1:patient:24h'}),expect.objectContaining({dedupeKey:'session:s1:therapist:24h'})])}));expect(p.auditLog.create).toHaveBeenCalled()});

 it('respects disabled patient reminder preferences',async()=>{const p=mock();const soon=new Date(Date.now()+60*60_000);p.session.findMany.mockResolvedValue([{id:'s1',patientId:'p1',therapistId:'t1',startsAt:soon,type:'INDIVIDUAL'}]);p.therapeuticTask.findMany.mockResolvedValue([]);p.consentRecord.findMany.mockResolvedValue([]);p.invoice.findMany.mockResolvedValue([]);p.notificationPreference.findMany.mockResolvedValue([{patientId:'p1',appointmentReminders:false,taskReminders:true,consentReminders:true,invoiceReminders:true,reminderHoursBefore:24},{userId:'t1',appointmentReminders:true,taskReminders:true,consentReminders:true,invoiceReminders:true,reminderHoursBefore:24}]);p.notification.createMany.mockResolvedValue({count:1});await new NotificationsService(p).processDue(owner);const rows=p.notification.createMany.mock.calls[0][0].data;expect(rows).toHaveLength(1);expect(rows[0]).toEqual(expect.objectContaining({audience:'PROFESSIONAL',userId:'t1'}));});
 it('historia B: el recordatorio de un terapeuta dado de baja sin reasignar va a OWNER/ADMIN activos, con dedupeKey propia',async()=>{
  const p=mock(FAKE_TEAM.map((m)=>m.userId==='t1'?{...m,status:'REMOVED'}:m));
  const soon=new Date(Date.now()+60*60_000);
  p.session.findMany.mockResolvedValue([{id:'s1',patientId:'p1',therapistId:'t1',startsAt:soon,type:'INDIVIDUAL'}]);
  p.therapeuticTask.findMany.mockResolvedValue([]);p.consentRecord.findMany.mockResolvedValue([]);p.invoice.findMany.mockResolvedValue([]);
  p.notification.createMany.mockResolvedValue({count:3});
  await new NotificationsService(p).processDue(owner);
  const rows=p.notification.createMany.mock.calls[0][0].data;
  const professional=rows.filter((r:any)=>r.audience==='PROFESSIONAL');
  expect(professional.map((r:any)=>r.userId).sort()).toEqual(['ad1','o1']);
  expect(professional.map((r:any)=>r.dedupeKey).sort()).toEqual(['session:s1:therapist:24h:to:ad1','session:s1:therapist:24h:to:o1']);
  expect(rows.some((r:any)=>r.userId==='t1')).toBe(false);
  expect(rows.filter((r:any)=>r.audience==='PATIENT')).toHaveLength(1);
 });
 it('historia B: tareas y citas de un dado de baja nunca van a él ni a otro THERAPIST, ni a OWNER/ADMIN de otro espacio o dados de baja',async()=>{
  const team=[...FAKE_TEAM.map((m)=>m.userId==='t1'?{...m,status:'REMOVED'}:m),{workspaceId:'w1',userId:'t2',role:'THERAPIST'},{workspaceId:'w1',userId:'ad-old',role:'ADMIN',status:'REMOVED'}];
  const p=mock(team);
  const soon=new Date(Date.now()+60*60_000);
  p.session.findMany.mockResolvedValue([{id:'s1',patientId:'p1',therapistId:'t1',startsAt:soon,type:'INDIVIDUAL'},{id:'s2',patientId:'p2',therapistId:'t2',startsAt:soon,type:'INDIVIDUAL'}]);
  p.therapeuticTask.findMany.mockResolvedValue([{id:'k1',patientId:'p1',dueDate:soon,patient:{clinicalProcesses:[{therapistId:'t1'}]}}]);
  p.consentRecord.findMany.mockResolvedValue([]);p.invoice.findMany.mockResolvedValue([]);
  p.notification.createMany.mockResolvedValue({count:1});
  await new NotificationsService(p).processDue(owner);
  const professional=p.notification.createMany.mock.calls[0][0].data.filter((r:any)=>r.audience==='PROFESSIONAL');
  const forT1=professional.filter((r:any)=>/^(session:s1|task:k1):/.test(r.dedupeKey));
  expect([...new Set(forT1.map((r:any)=>r.userId))].sort()).toEqual(['ad1','o1']);
  expect(professional.some((r:any)=>['t1','ad-old','o2'].includes(r.userId))).toBe(false);
  // t2 (activo) solo recibe lo suyo, nunca lo reenviado del dado de baja.
  expect(professional.filter((r:any)=>r.userId==='t2').map((r:any)=>r.dedupeKey)).toEqual(['session:s2:therapist:24h']);
 });
 it('portal query is scoped to patient and workspace',async()=>{const p=mock();p.patientPortalAccount.findFirst.mockResolvedValue({id:'pa1'});p.notification.findMany.mockResolvedValue([]);const portal={portalAccountId:'pa1',patientId:'p1',workspaceId:'w1'};await new NotificationsService(p).listPatient(portal);expect(p.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({workspaceId:'w1',patientId:'p1',audience:'PATIENT'})}))});
});
