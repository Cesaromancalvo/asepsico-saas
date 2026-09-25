import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PortalService } from '../src/portal/portal.service';
import { PatientCoreService } from '../src/patients/patient-core.service';

function prismaMock(){const p:any={
  patient:{findFirst:jest.fn()}, patientPortalAccount:{findFirst:jest.fn(),findUnique:jest.fn(),create:jest.fn(),upsert:jest.fn(),update:jest.fn(async()=>{throw new Error('update solo por id no permitido');}),updateMany:jest.fn().mockResolvedValue({count:1})},
  auditLog:{create:jest.fn()}, session:{findMany:jest.fn()}, therapeuticTask:{findMany:jest.fn()}, consentRecord:{findMany:jest.fn()}, invoice:{findMany:jest.fn()}, resourceShare:{findMany:jest.fn().mockResolvedValue([])}
}; p.$transaction=jest.fn(async(cb:any)=>cb(p)); return p;}
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
    const prisma=prismaMock(); prisma.patientPortalAccount.findFirst.mockResolvedValue({id:'a1',workspaceId:'ws-1',patientId:'p1',failedLoginAttempts:4,passwordHash:await bcrypt.hash('Correct12345',4),lockedUntil:null});
    const service=new PortalService(prisma,jwt);
    await expect(service.login({email:'p@example.com',password:'Wrong123456'})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.patientPortalAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'a1',workspaceId:'ws-1'}),data:expect.objectContaining({failedLoginAttempts:5,lockedUntil:expect.any(Date)})}));
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
    const update=prisma.patientPortalAccount.updateMany.mock.calls[0][0];
    expect(update.where).toEqual(expect.objectContaining({id:'a1',patientId:'p1',workspaceId:'ws-1'}));
    expect(update.data.mustChangePassword).toBe(false);
    expect(await bcrypt.compare('Permanent1234',update.data.passwordHash)).toBe(true);
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// A1 / B2: enable() respeta Patient.portalAccessMode y no cambia el tipo de una cuenta existente.
// Datos ficticios.
// ---------------------------------------------------------------------------------------------
describe('Portal enable() respects portalAccessMode',()=>{
  const staff={sub:'u-admin',role:'ADMIN'};
  function enablePrisma(portalAccessMode:string, existing:any=null){
    const prisma=prismaMock();
    prisma.patient.findFirst.mockResolvedValue({id:'p1',workspaceId:'ws-1',portalAccessMode});
    prisma.patientPortalAccount.findUnique.mockResolvedValue(existing);
    prisma.patientPortalAccount.create.mockImplementation(async({data}:any)=>({id:'acc-new',patientId:data.patientId,accessorType:data.accessorType,isActive:true}));
    prisma.patientPortalAccount.updateMany.mockResolvedValue({count:1});
    prisma.patientPortalAccount.findFirst.mockResolvedValue({id:existing?.id,patientId:'p1',accessorType:existing?.accessorType,isActive:true});
    return prisma;
  }
  const dto=(accessorType:'PATIENT'|'GUARDIAN',email='ficticio@example.com')=>({email,temporaryPassword:'Password1234',accessorType,guardianName:accessorType==='GUARDIAN'?'Tutor Ficticio':undefined} as any);

  it('PATIENT_ONLY rejects a GUARDIAN account with 400, creates nothing and audits the rejection without the email',async()=>{
    const prisma=enablePrisma('PATIENT_ONLY');
    await expect(new PortalService(prisma,jwt).enable('ws-1',staff,'p1',dto('GUARDIAN','tutor.ficticio@example.com'))).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.patientPortalAccount.create).not.toHaveBeenCalled();
    expect(prisma.patientPortalAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({data:expect.objectContaining({workspaceId:'ws-1',action:'PORTAL_ACCOUNT_ENABLE_REJECTED',entityId:'p1',metadata:expect.objectContaining({accessorType:'GUARDIAN',portalAccessMode:'PATIENT_ONLY'})})});
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('example.com');
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('Tutor Ficticio');
  });

  it('GUARDIAN_ONLY rejects a PATIENT account with 400',async()=>{
    const prisma=enablePrisma('GUARDIAN_ONLY');
    await expect(new PortalService(prisma,jwt).enable('ws-1',staff,'p1',dto('PATIENT'))).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.patientPortalAccount.create).not.toHaveBeenCalled();
  });

  it('SHARED allows both PATIENT and GUARDIAN accounts',async()=>{
    const prisma=enablePrisma('SHARED');
    const service=new PortalService(prisma,jwt);
    await expect(service.enable('ws-1',staff,'p1',dto('PATIENT','paciente.ficticio@example.com'))).resolves.toEqual(expect.objectContaining({accessorType:'PATIENT'}));
    await expect(service.enable('ws-1',staff,'p1',dto('GUARDIAN','tutor.ficticio@example.com'))).resolves.toEqual(expect.objectContaining({accessorType:'GUARDIAN'}));
    expect(prisma.patientPortalAccount.create).toHaveBeenCalledTimes(2);
  });

  it('rejects reactivating the email of a PATIENT account as GUARDIAN (and vice versa)',async()=>{
    const existingPatient={id:'acc-1',patientId:'p1',workspaceId:'ws-1',accessorType:'PATIENT',isActive:false};
    let prisma=enablePrisma('SHARED',existingPatient);
    await expect(new PortalService(prisma,jwt).enable('ws-1',staff,'p1',dto('GUARDIAN'))).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.patientPortalAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.patientPortalAccount.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({data:expect.objectContaining({action:'PORTAL_ACCOUNT_ENABLE_REJECTED',metadata:expect.objectContaining({reason:'ACCESSOR_TYPE_MISMATCH'})})});

    prisma=enablePrisma('SHARED',{...existingPatient,accessorType:'GUARDIAN'});
    await expect(new PortalService(prisma,jwt).enable('ws-1',staff,'p1',dto('PATIENT'))).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.patientPortalAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.patientPortalAccount.update).not.toHaveBeenCalled();
  });

  it('reactivating an existing account of the same type is scoped by id, workspaceId and patientId',async()=>{
    const prisma=enablePrisma('SHARED',{id:'acc-1',patientId:'p1',workspaceId:'ws-1',accessorType:'GUARDIAN',isActive:false});
    await new PortalService(prisma,jwt).enable('ws-1',staff,'p1',dto('GUARDIAN'));
    expect(prisma.patientPortalAccount.update).not.toHaveBeenCalled();
    expect(prisma.patientPortalAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:{id:'acc-1',workspaceId:'ws-1',patientId:'p1'},data:expect.objectContaining({isActive:true,accessorType:'GUARDIAN'})}));
  });
});

// ---------------------------------------------------------------------------------------------
// A2: cambiar portalAccessMode (PATCH /patients/:id) revoca las cuentas incompatibles en la
// MISMA transacción que el cambio de modo, y lo audita. El doble de Prisma simula la
// transacción: las escrituras hechas vía `tx` solo se confirman si el callback termina bien;
// las hechas directamente sobre `prisma` (fuera de transacción) se confirman al momento.
// ---------------------------------------------------------------------------------------------
type Account={id:string;workspaceId:string;patientId:string;accessorType:'PATIENT'|'GUARDIAN';isActive:boolean};
function transactionalPrisma(initialMode:string, accounts:Account[], opts:{failAuditAction?:string}={}){
  let state={patient:{id:'p1',workspaceId:'ws-1',status:'ACTIVE',portalAccessMode:initialMode,firstName:'Paciente',lastName:'Ficticio',consultationReason:null as any},accounts:accounts.map(a=>({...a})),audit:[] as any[]};
  const clone=(s:typeof state)=>({patient:{...s.patient},accounts:s.accounts.map(a=>({...a})),audit:[...s.audit]});
  const matches=(a:Account,where:any)=>Object.entries(where).every(([k,v]:any)=>{
    if(v&&typeof v==='object'&&'in' in v) return v.in.includes((a as any)[k]);
    return (a as any)[k]===v;
  });
  const client=(get:()=>typeof state)=>({
    patient:{
      findFirst:jest.fn(async({where,select}:any)=>{
        const p=get().patient; if(where.id!==p.id||where.workspaceId!==p.workspaceId) return null;
        if(select) return {portalAccessMode:p.portalAccessMode};
        return {...p,_count:{sessions:0,clinicalProcesses:0},clinicalProcesses:[],sessions:[]};
      }),
      updateMany:jest.fn(async({where,data}:any)=>{
        const p=get().patient; if(where.id!==p.id||where.workspaceId!==p.workspaceId) return {count:0};
        for(const [k,v] of Object.entries(data)) if(v!==undefined) (p as any)[k]=v;
        return {count:1};
      }),
    },
    patientPortalAccount:{
      findMany:jest.fn(async({where}:any)=>get().accounts.filter(a=>matches(a,where)).map(a=>({id:a.id}))),
      updateMany:jest.fn(async({where,data}:any)=>{const hit=get().accounts.filter(a=>matches(a,where)); hit.forEach(a=>Object.assign(a,data)); return {count:hit.length};}),
    },
    auditLog:{create:jest.fn(async({data}:any)=>{ if(opts.failAuditAction&&data.action===opts.failAuditAction) throw new Error('audit down'); get().audit.push(data); return data; })},
    session:{findMany:jest.fn().mockResolvedValue([])},
  });
  const root:any=client(()=>state);
  root.$transaction=jest.fn(async(cb:any)=>{
    const draft=clone(state); const tx=client(()=>draft); root.lastTx=tx;
    const result=await cb(tx); state=draft; return result;
  });
  return {prisma:root, state:()=>state};
}
const accountsShared=():Account[]=>[
  {id:'acc-pat',workspaceId:'ws-1',patientId:'p1',accessorType:'PATIENT',isActive:true},
  {id:'acc-tut',workspaceId:'ws-1',patientId:'p1',accessorType:'GUARDIAN',isActive:true},
];

describe('Changing portalAccessMode revokes incompatible portal accounts',()=>{
  const admin:any={sub:'u-admin',role:'ADMIN',workspaceId:'ws-1'};

  it('SHARED -> PATIENT_ONLY deactivates the GUARDIAN account inside the transaction and audits modes and ids',async()=>{
    const {prisma,state}=transactionalPrisma('SHARED',accountsShared());
    await new PatientCoreService(prisma).update('ws-1',admin,'p1',{portalAccessMode:'PATIENT_ONLY'} as any);
    const s=state();
    expect(s.patient.portalAccessMode).toBe('PATIENT_ONLY');
    expect(s.accounts.find(a=>a.id==='acc-tut')!.isActive).toBe(false);
    expect(s.accounts.find(a=>a.id==='acc-pat')!.isActive).toBe(true);
    expect(s.audit).toContainEqual(expect.objectContaining({workspaceId:'ws-1',action:'PATIENT_PORTAL_ACCESS_MODE_CHANGED',entityId:'p1',metadata:{previousMode:'SHARED',newMode:'PATIENT_ONLY',revokedAccountIds:['acc-tut']}}));
    // Revocación hecha con el cliente transaccional y acotada a workspace + paciente.
    expect(prisma.patientPortalAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.lastTx.patientPortalAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({workspaceId:'ws-1',patientId:'p1'}),data:{isActive:false}}));
  });

  it('SHARED -> GUARDIAN_ONLY deactivates the PATIENT account',async()=>{
    const {prisma,state}=transactionalPrisma('SHARED',accountsShared());
    await new PatientCoreService(prisma).update('ws-1',admin,'p1',{portalAccessMode:'GUARDIAN_ONLY'} as any);
    const s=state();
    expect(s.accounts.find(a=>a.id==='acc-pat')!.isActive).toBe(false);
    expect(s.accounts.find(a=>a.id==='acc-tut')!.isActive).toBe(true);
    expect(s.audit).toContainEqual(expect.objectContaining({action:'PATIENT_PORTAL_ACCESS_MODE_CHANGED',metadata:{previousMode:'SHARED',newMode:'GUARDIAN_ONLY',revokedAccountIds:['acc-pat']}}));
  });

  it('does not touch accounts of other patients or workspaces',async()=>{
    const others:Account[]=[
      {id:'acc-other-p',workspaceId:'ws-1',patientId:'p2',accessorType:'GUARDIAN',isActive:true},
      {id:'acc-other-ws',workspaceId:'ws-2',patientId:'p1',accessorType:'GUARDIAN',isActive:true},
    ];
    const {prisma,state}=transactionalPrisma('SHARED',[...accountsShared(),...others]);
    await new PatientCoreService(prisma).update('ws-1',admin,'p1',{portalAccessMode:'PATIENT_ONLY'} as any);
    expect(state().accounts.filter(a=>a.id.startsWith('acc-other')).every(a=>a.isActive)).toBe(true);
  });

  it('if the audit of the mode change fails, neither the mode nor the revocation is committed',async()=>{
    const {prisma,state}=transactionalPrisma('SHARED',accountsShared(),{failAuditAction:'PATIENT_PORTAL_ACCESS_MODE_CHANGED'});
    await expect(new PatientCoreService(prisma).update('ws-1',admin,'p1',{portalAccessMode:'PATIENT_ONLY'} as any)).rejects.toThrow('audit down');
    const s=state();
    expect(s.patient.portalAccessMode).toBe('SHARED');
    expect(s.accounts.every(a=>a.isActive)).toBe(true);
    expect(s.audit).toHaveLength(0);
  });

  it('an update without portalAccessMode does not touch portal accounts',async()=>{
    const {prisma,state}=transactionalPrisma('SHARED',accountsShared());
    await new PatientCoreService(prisma).update('ws-1',admin,'p1',{phone:'600000000'} as any);
    expect(state().accounts.every(a=>a.isActive)).toBe(true);
    expect(state().audit.map((a:any)=>a.action)).toEqual(['PATIENT_UPDATED']);
  });
});
