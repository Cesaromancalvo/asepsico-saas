import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PortalService } from '../src/portal/portal.service';
import { decryptField } from '../src/common/crypto/field-encryption';

const portal={portalAccountId:'pa1',patientId:'p1',workspaceId:'w1'};
function mockPrisma(){
 const p:any={
  therapeuticTask:{findFirst:jest.fn(),updateMany:jest.fn(),update:jest.fn(async()=>{throw new Error('update solo por id no permitido');})},
  auditLog:{create:jest.fn()},
 };
 // La escritura y su auditoría van en la misma transacción (mismo mock como cliente tx).
 p.$transaction=jest.fn(async(cb:any)=>cb(p));
 return p;
}

describe('Sprint 12 task workflow security',()=>{
 it('only saves progress for the authenticated portal patient and workspace',async()=>{
  const prisma=mockPrisma(); prisma.therapeuticTask.findFirst.mockResolvedValueOnce({id:'t1',patientId:'p1',status:'PENDING',startedAt:null}); prisma.therapeuticTask.updateMany.mockImplementation(async({data}:any)=>{ prisma.therapeuticTask.findFirst.mockResolvedValueOnce({id:'t1',...data}); return {count:1}; });
  const service=new PortalService(prisma,{} as any); const result=await service.saveTaskProgress(portal,'t1',{patientFeedback:'Registro del paciente'});
  expect(prisma.therapeuticTask.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'t1',patientId:'p1',patient:{workspaceId:'w1'}})}));
  // El feedback del paciente se cifra en reposo: nunca debe llegar en claro a la base de datos.
  expect(prisma.therapeuticTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'t1',patientId:'p1',patient:{workspaceId:'w1'}}),data:expect.objectContaining({status:'IN_PROGRESS',patientFeedback:expect.stringMatching(/^enc:v1:/)})}));
  const stored=prisma.therapeuticTask.updateMany.mock.calls[0][0].data.patientFeedback;
  expect(stored).not.toContain('Registro del paciente');
  expect(decryptField(stored)).toBe('Registro del paciente');
  // Al paciente se le devuelve descifrado.
  expect(result.patientFeedback).toBe('Registro del paciente');
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
  const prisma=mockPrisma(); prisma.therapeuticTask.findFirst.mockResolvedValueOnce({id:'t1',status:'IN_PROGRESS',patientFeedback:'Contenido sensible'}).mockResolvedValueOnce({id:'t1',status:'SUBMITTED'}); prisma.therapeuticTask.updateMany.mockResolvedValue({count:1});
  await new PortalService(prisma,{} as any).submitTask(portal,'t1');
  expect(prisma.therapeuticTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'t1',patientId:'p1',patient:{workspaceId:'w1'}}),data:expect.objectContaining({status:'SUBMITTED'})}));
  expect(prisma.auditLog.create).toHaveBeenCalledWith({data:expect.objectContaining({action:'PORTAL_TASK_SUBMITTED',metadata:{patientId:'p1'}})});
  expect(JSON.stringify(prisma.auditLog.create.mock.calls[0][0])).not.toContain('Contenido sensible');
 });
});
