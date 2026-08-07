import { NotificationsService } from '../src/notifications/notifications.service';

const portal={portalAccountId:'pa1',patientId:'p1',workspaceId:'w1'};

describe('Usability persistence: notification preferences',()=>{
  it('saves preferences and returns the same values on reload',async()=>{
    let stored:any=null;
    const prisma:any={
      patientPortalAccount:{findFirst:jest.fn().mockResolvedValue({id:'pa1'})},
      patient:{findFirst:jest.fn().mockResolvedValue({phone:'+34123456789'})},
      notificationPreference:{
        findUnique:jest.fn(async()=>stored),
        upsert:jest.fn(async({create,update}:any)=>{stored=stored?{...stored,...update}:{id:'pref1',...create};return stored;}),
      },
    };
    const service=new NotificationsService(prisma);
    await service.updatePatientPreferences(portal,{appointmentReminders:false,emailEnabled:true,smsEnabled:true,reminderHoursBefore:72} as any);
    const reloaded:any=await service.getPatientPreferences(portal);
    expect(reloaded).toEqual(expect.objectContaining({appointmentReminders:false,emailEnabled:true,smsEnabled:true,reminderHoursBefore:72}));
  });

  it('does not claim SMS delivery when the patient has no phone',async()=>{
    let stored:any=null;
    const prisma:any={
      patientPortalAccount:{findFirst:jest.fn().mockResolvedValue({id:'pa1'})},
      patient:{findFirst:jest.fn().mockResolvedValue({phone:null})},
      notificationPreference:{findUnique:jest.fn(async()=>stored),upsert:jest.fn(async({create}:any)=>{stored={id:'pref1',...create};return stored;})},
    };
    const saved:any=await new NotificationsService(prisma).updatePatientPreferences(portal,{smsEnabled:true} as any);
    expect(saved.smsEnabled).toBe(false);
  });
});
