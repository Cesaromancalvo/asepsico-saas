import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExportsService } from '../src/exports/exports.service';

const owner:any={sub:'u-owner',workspaceId:'w1',role:'OWNER'};
const therapist:any={sub:'u-therapist',workspaceId:'w1',role:'THERAPIST'};
const receptionist:any={sub:'u-reception',workspaceId:'w1',role:'RECEPTIONIST'};

function mockPrisma(){
  return {
    patient:{findFirst:jest.fn(),count:jest.fn()},
    workspace:{findUnique:jest.fn()},
    session:{count:jest.fn()},
    invoice:{count:jest.fn()},
    therapeuticResource:{count:jest.fn()},
    conversation:{count:jest.fn()},
    auditLog:{create:jest.fn(),findMany:jest.fn()},
    workspaceMember:{count:jest.fn()},
    patientPortalAccount:{count:jest.fn()},
    consentRecord:{count:jest.fn()},
  } as any;
}

describe('Sprint 14 exports and pilot readiness security',()=>{
  it('scopes therapist patient access by workspace and assigned clinical process',async()=>{
    const prisma=mockPrisma();
    prisma.patient.findFirst
      .mockResolvedValueOnce({id:'p1'})
      .mockResolvedValueOnce({id:'p1',firstName:'Ana',clinicalHistory:{reason:'sensible'}});
    prisma.auditLog.create.mockResolvedValue({});
    const service=new ExportsService(prisma);
    const result=await service.exportPatient(therapist,'p1');
    expect(prisma.patient.findFirst.mock.calls[0][0]).toEqual(expect.objectContaining({where:expect.objectContaining({
      id:'p1',workspaceId:'w1',deletedAt:null,
      clinicalProcesses:{some:{therapistId:'u-therapist'}},
    })}));
    expect(result.exportType).toBe('PATIENT_CLINICAL_RECORD');
  });

  it('returns not found instead of leaking an inaccessible patient',async()=>{
    const prisma=mockPrisma();
    prisma.patient.findFirst.mockResolvedValue(null);
    await expect(new ExportsService(prisma).exportPatient(therapist,'foreign')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects non-clinical roles from patient exports',async()=>{
    const prisma=mockPrisma();
    await expect(new ExportsService(prisma).exportPatient(receptionist,'p1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });

  it('restricts workspace export and pilot readiness to owner/admin',async()=>{
    const prisma=mockPrisma();
    const service=new ExportsService(prisma);
    await expect(service.exportWorkspace(therapist)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getPilotReadiness(therapist)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('audits a patient export without copying clinical payload into metadata',async()=>{
    const prisma=mockPrisma();
    prisma.patient.findFirst
      .mockResolvedValueOnce({id:'p1'})
      .mockResolvedValueOnce({id:'p1',firstName:'Ana',clinicalHistory:{reason:'TRAUMA CONFIDENCIAL'}});
    prisma.auditLog.create.mockResolvedValue({});
    await new ExportsService(prisma).exportPatient(owner,'p1');
    const auditCall=prisma.auditLog.create.mock.calls[0][0];
    expect(auditCall.data).toEqual(expect.objectContaining({workspaceId:'w1',actorId:'u-owner',action:'PATIENT_DATA_EXPORTED',entityType:'Patient',entityId:'p1'}));
    expect(auditCall.data.metadata).toEqual(expect.objectContaining({format:'JSON'}));
    expect(JSON.stringify(auditCall)).not.toContain('TRAUMA CONFIDENCIAL');
  });

  it('builds pilot readiness from workspace-scoped counters',async()=>{
    const prisma=mockPrisma();
    prisma.workspaceMember.count.mockResolvedValue(2);
    prisma.patient.count.mockResolvedValue(3);
    prisma.session.count.mockResolvedValue(1);
    prisma.patientPortalAccount.count.mockResolvedValue(2);
    prisma.consentRecord.count.mockResolvedValue(0);
    prisma.invoice.count.mockResolvedValue(1);
    const result=await new ExportsService(prisma).getPilotReadiness(owner);
    expect(prisma.patient.count).toHaveBeenCalledWith({where:{workspaceId:'w1',deletedAt:null}});
    expect(prisma.session.count).toHaveBeenCalledWith({where:expect.objectContaining({workspaceId:'w1',status:'SCHEDULED'})});
    expect(result.checks.find((x:any)=>x.key==='patients')?.status).toBe('READY');
    expect(result.checks.find((x:any)=>x.key==='billing')?.status).toBe('WARNING');
    expect(result.checks.find((x:any)=>x.key==='backup')?.status).toBe('MANUAL');
  });
});
