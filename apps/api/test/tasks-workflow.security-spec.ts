import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PortalService } from '../src/portal/portal.service';

const portal={portalAccountId:'pa1',patientId:'p1',workspaceId:'w1'};
function mockPrisma(){
 const p:any={
  therapeuticTask:{findFirst:jest.fn(),update:jest.fn()},
  auditLog:{create:jest.fn()},
 };
 return p;
}

describe('Sprint 12 task workflow security',()=>{
 it('only saves progress for the authenticated portal patient and workspace',async()=>{
  const prisma=mockPrisma(); prisma.therapeuticTask.findFirst.mockResolvedValue({id:'t1',patientId:'p1',status:'PENDING',startedAt:null}); prisma.therapeuticTask.update.mockResolvedValue({id:'t1',status:'IN_PROGRESS'});
  const service=new PortalService(prisma,{} as any); await service.saveTaskProgress(portal,'t1',{patientFeedback:'Registro del paciente'});
  expect(prisma.therapeuticTask.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'t1',patientId:'p1',patient:{workspaceId:'w1'}})}));
  expect(prisma.therapeuticTask.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'IN_PROGRESS',patientFeedback:'Registro del paciente'})}));
 });

 it('does not expose or update a task outside the patient context',async()=>{
  const prisma=mockPrisma(); prisma.therapeuticTask.findFirst.mockResolvedValue(null);
  await expect(new PortalService(prisma,{} as any).saveTaskProgress(portal,'foreign',{patientFeedback:'x'})).rejects.toBeInstanceOf(NotFoundException);
 });

 it('requires a response before submission',async()=>{
  const prisma=mockPrisma(); prisma.therapeuticTask.findFirst.mockResolvedValue({id:'t1',status:'IN_PROGRESS',patientFeedback:'   '});
  await expect(new PortalService(prisma,{} as any).submitTask(portal,'t1')).rejects.toBeInstanceOf(BadRequestException);
 });

 it('submits an eligible task and records an audit event without clinical content',async()=>{
  const prisma=mockPrisma(); prisma.therapeuticTask.findFirst.mockResolvedValue({id:'t1',status:'IN_PROGRESS',patientFeedback:'Contenido sensible'}); prisma.therapeuticTask.update.mockResolvedValue({id:'t1',status:'SUBMITTED'});
  await new PortalService(prisma,{} as any).submitTask(portal,'t1');
  expect(prisma.therapeuticTask.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'SUBMITTED'})}));
  expect(prisma.auditLog.create).toHaveBeenCalledWith({data:expect.objectContaining({action:'PORTAL_TASK_SUBMITTED',metadata:{patientId:'p1'}})});
  expect(JSON.stringify(prisma.auditLog.create.mock.calls[0][0])).not.toContain('Contenido sensible');
 });
});
