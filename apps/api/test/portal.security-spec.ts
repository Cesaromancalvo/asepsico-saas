import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PortalService } from '../src/portal/portal.service';

function prismaMock(){return {
  patient:{findFirst:jest.fn()}, patientPortalAccount:{findFirst:jest.fn(),upsert:jest.fn(),update:jest.fn(),updateMany:jest.fn()},
  auditLog:{create:jest.fn()}, session:{findMany:jest.fn()}, therapeuticTask:{findMany:jest.fn()}, consentRecord:{findMany:jest.fn()}, invoice:{findMany:jest.fn()}, resourceShare:{findMany:jest.fn().mockResolvedValue([])}
} as any}
const jwt:any={signAsync:jest.fn().mockResolvedValue('portal-token')};

describe('Patient portal security',()=>{
  it('blocks therapists from provisioning portal accounts',async()=>{
    const service=new PortalService(prismaMock(),jwt);
    await expect(service.enable('ws-1',{sub:'t1',role:'THERAPIST'},'p1',{email:'p@example.com',temporaryPassword:'Password1234'} as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('uses a generic error for unknown credentials',async()=>{
    const prisma=prismaMock(); prisma.patientPortalAccount.findFirst.mockResolvedValue(null);
    const service=new PortalService(prisma,jwt);
    await expect(service.login({email:'missing@example.com',password:'Password1234'})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('locks the account after five failed attempts',async()=>{
    const prisma=prismaMock(); prisma.patientPortalAccount.findFirst.mockResolvedValue({id:'a1',failedLoginAttempts:4,passwordHash:await bcrypt.hash('Correct12345',4),lockedUntil:null});
    const service=new PortalService(prisma,jwt);
    await expect(service.login({email:'p@example.com',password:'Wrong123456'})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.patientPortalAccount.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({failedLoginAttempts:5,lockedUntil:expect.any(Date)})}));
  });

  it('dashboard queries only the authenticated patient and excludes clinical notes',async()=>{
    const prisma=prismaMock(); prisma.patientPortalAccount.findFirst.mockResolvedValue({id:'a1'}); prisma.patient.findFirst.mockResolvedValue({id:'p1',firstName:'Ana',lastName:'Sol'});
    prisma.session.findMany.mockResolvedValue([]); prisma.therapeuticTask.findMany.mockResolvedValue([]); prisma.consentRecord.findMany.mockResolvedValue([]); prisma.invoice.findMany.mockResolvedValue([]);
    const service=new PortalService(prisma,jwt); await service.dashboard({portalAccountId:'a1',patientId:'p1',workspaceId:'ws-1'});
    expect(prisma.session.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({patientId:'p1',workspaceId:'ws-1'}),select:expect.not.objectContaining({notes:true,internalSummary:true})}));
    expect(prisma.therapeuticTask.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({patientId:'p1'}),select:expect.not.objectContaining({clinicianNotes:true})}));
  });
});

describe('Patient portal usability persistence',()=>{
  it('returns the forced-password-change state in the dashboard',async()=>{
    const prisma=prismaMock(); prisma.patientPortalAccount.findFirst.mockResolvedValue({id:'a1',mustChangePassword:true}); prisma.patient.findFirst.mockResolvedValue({id:'p1',firstName:'Ana',lastName:'Sol'});
    prisma.session.findMany.mockResolvedValue([]); prisma.therapeuticTask.findMany.mockResolvedValue([]); prisma.consentRecord.findMany.mockResolvedValue([]); prisma.invoice.findMany.mockResolvedValue([]);
    const result:any=await new PortalService(prisma,jwt).dashboard({portalAccountId:'a1',patientId:'p1',workspaceId:'ws-1'});
    expect(result.mustChangePassword).toBe(true);
  });

  it('persists a changed password and clears the temporary-password flag',async()=>{
    const prisma=prismaMock(); const currentHash=await bcrypt.hash('Temporary1234',4);
    prisma.patientPortalAccount.findFirst.mockResolvedValue({id:'a1',isActive:true,passwordHash:currentHash});
    const result=await new PortalService(prisma,jwt).changePassword({portalAccountId:'a1',patientId:'p1',workspaceId:'ws-1'},{currentPassword:'Temporary1234',newPassword:'Permanent1234'} as any);
    expect(result).toEqual({ok:true});
    const update=prisma.patientPortalAccount.update.mock.calls[0][0];
    expect(update.data.mustChangePassword).toBe(false);
    expect(await bcrypt.compare('Permanent1234',update.data.passwordHash)).toBe(true);
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
});
