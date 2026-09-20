
/































Portal.service · TS
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { decryptField, encryptField } from '../common/crypto/field-encryption';
import { ChangePortalPasswordDto, EnablePortalDto, PortalLoginDto } from './dto/portal.dto';
import { SaveTaskProgressDto } from './dto/task-response.dto';
 
@Injectable()
export class PortalService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}
 
  private assertStaff(actor: any) {
    if (!['OWNER','ADMIN','ASSISTANT'].includes(actor?.role)) throw new ForbiddenException();
  }
 
  async enable(workspaceId: string, actor: any, patientId: string, dto: EnablePortalDto) {
    this.assertStaff(actor);
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId, deletedAt: null } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    const passwordHash = await bcrypt.hash(dto.temporaryPassword, 12);
    const email = dto.email.toLowerCase().trim();
    const accessorType = dto.accessorType ?? 'PATIENT';
 
    // Antes: una sola cuenta por paciente, con upsert por patientId. Ahora puede haber
    // varias (el paciente y cada tutor, por separado), así que se localiza por email —que
    // sigue siendo único en todo el sistema— para saber si ya existe esta cuenta en
    // concreto o hay que crear una nueva.
    const existing = await (this.prisma as any).patientPortalAccount.findUnique({ where: { email } });
    if (existing && existing.patientId !== patientId) {
      throw new BadRequestException('Ese correo ya está en uso por la cuenta de portal de otro paciente');
    }
 
    const accountData = {
      passwordHash,
      isActive: true,
      mustChangePassword: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
      accessorType,
      guardianName: accessorType === 'GUARDIAN' ? dto.guardianName ?? null : null,
      guardianRelationship: accessorType === 'GUARDIAN' ? dto.guardianRelationship ?? null : null,
    };
 
    const account = existing
      ? await (this.prisma as any).patientPortalAccount.update({
          where: { id: existing.id },
          data: accountData,
          select: { id:true, patientId:true, email:true, accessorType:true, guardianName:true, guardianRelationship:true, isActive:true, mustChangePassword:true, createdAt:true, updatedAt:true },
        })
      : await (this.prisma as any).patientPortalAccount.create({
          data: { workspaceId, patientId, email, ...accountData },
          select: { id:true, patientId:true, email:true, accessorType:true, guardianName:true, guardianRelationship:true, isActive:true, mustChangePassword:true, createdAt:true, updatedAt:true },
        });
 
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action:'PORTAL_ACCOUNT_ENABLED', entityType:'PatientPortalAccount', entityId:account.id, metadata:{ patientId, accessorType } } });
    return account;
  }
 
  async disable(workspaceId: string, actor: any, patientId: string) {
    this.assertStaff(actor);
    // Desactiva TODAS las cuentas de portal del paciente (la suya propia y las de
    // cualquier tutor) — "desactivar el portal de este paciente" apaga el acceso entero,
    // no solo uno de los accesos. Revocar un tutor concreto sin tocar al resto es una
    // función futura, no la de hoy.
    const result = await (this.prisma as any).patientPortalAccount.updateMany({ where:{ patientId, workspaceId }, data:{ isActive:false } });
    if (!result.count) throw new NotFoundException();
    await this.prisma.auditLog.create({ data:{ workspaceId, actorId:actor.sub, action:'PORTAL_ACCOUNT_DISABLED', entityType:'PatientPortalAccount', entityId:patientId, metadata:{ patientId } } });
    return { ok:true };
  }
 
  async login(dto: PortalLoginDto) {
    const email = dto.email.toLowerCase().trim();
    const account = await (this.prisma as any).patientPortalAccount.findFirst({ where:{ email, isActive:true }, include:{ patient:{ select:{ id:true, firstName:true, lastName:true, status:true } } } });
    if (!account) throw new UnauthorizedException('Credenciales incorrectas');
    if (account.lockedUntil && account.lockedUntil > new Date()) throw new UnauthorizedException('Cuenta temporalmente bloqueada');
    const valid = await bcrypt.compare(dto.password, account.passwordHash);
    if (!valid) {
      const attempts = account.failedLoginAttempts + 1;
      await (this.prisma as any).patientPortalAccount.update({ where:{ id:account.id }, data:{ failedLoginAttempts: attempts, lockedUntil: attempts >= 5 ? new Date(Date.now()+15*60_000) : null } });
      throw new UnauthorizedException('Credenciales incorrectas');
    }
    await (this.prisma as any).patientPortalAccount.update({ where:{ id:account.id }, data:{ failedLoginAttempts:0, lockedUntil:null, lastLoginAt:new Date() } });
    const accessToken = await this.jwt.signAsync({
      kind:'patient_portal',
      portalAccountId:account.id,
      patientId:account.patientId,
      workspaceId:account.workspaceId,
      // Necesario para que PortalGuard acepte el token bajo el nuevo modelo, y para que el
      // resto del código pueda distinguir "paciente" de "tutor" si hace falta.
      accessorType:account.accessorType,
    }, { expiresIn:'30m' });
    return { accessToken, patient:account.patient, mustChangePassword:account.mustChangePassword, accessorType:account.accessorType, guardianName:account.guardianName };
  }
 
  async dashboard(portal: any) {
    const account = await (this.prisma as any).patientPortalAccount.findFirst({ where:{ id:portal.portalAccountId, patientId:portal.patientId, workspaceId:portal.workspaceId, isActive:true } });
    if (!account) throw new UnauthorizedException();
    const [patient, sessions, tasks, consents, invoices, resources] = await Promise.all([
      this.prisma.patient.findFirst({ where:{ id:portal.patientId, workspaceId:portal.workspaceId, deletedAt:null }, select:{ id:true, firstName:true, lastName:true, email:true, phone:true } }),
      this.prisma.session.findMany({ where:{ patientId:portal.patientId, workspaceId:portal.workspaceId, startsAt:{ gte:new Date(Date.now()-24*60*60_000) } }, orderBy:{ startsAt:'asc' }, take:10, select:{ id:true, startsAt:true, endsAt:true, status:true, type:true, location:true, videoCallUrl:true } }),
      (this.prisma as any).therapeuticTask.findMany({ where:{ patientId:portal.patientId, status:{ in:['PENDING','IN_PROGRESS','CHANGES_REQUESTED','SUBMITTED','COMPLETED'] } }, orderBy:[{ dueDate:'asc' },{ createdAt:'desc' }], select:{ id:true,title:true,instructions:true,status:true,dueDate:true,patientFeedback:true,reviewComment:true,submittedAt:true,completedAt:true,updatedAt:true } }),
      (this.prisma as any).consentRecord.findMany({ where:{ patientId:portal.patientId, workspaceId:portal.workspaceId }, orderBy:{ createdAt:'desc' }, select:{ id:true, title:true, type:true, status:true, signedAt:true, expiresAt:true } }),
      (this.prisma as any).invoice.findMany({ where:{ patientId:portal.patientId, workspaceId:portal.workspaceId, status:{ not:'DRAFT' } }, orderBy:{ createdAt:'desc' }, take:12, select:{ id:true, invoiceNumber:true, status:true, currency:true, issueDate:true, dueDate:true, totalCents:true, paidCents:true } }),
      (this.prisma as any).resourceShare.findMany({ where:{ patientId:portal.patientId, workspaceId:portal.workspaceId, revokedAt:null, resource:{ archivedAt:null } }, orderBy:{ sharedAt:'desc' }, select:{ id:true, sharedAt:true, resource:{ select:{ id:true,title:true,description:true,type:true,category:true,url:true,fileName:true,mimeType:true } } } }),
    ]);
    if (!patient) throw new NotFoundException();
    // instructions/patientFeedback/reviewComment están cifrados en reposo (ver
    // patient-tasks.service.ts) — hay que descifrarlos aquí o el paciente/tutor vería el
    // texto cifrado en bruto en vez de sus propias tareas.
    const decryptedTasks = tasks.map((task: any) => ({
      ...task,
      instructions: decryptField(task.instructions) ?? null,
      patientFeedback: decryptField(task.patientFeedback) ?? null,
      reviewComment: decryptField(task.reviewComment) ?? null,
    }));
    return { patient, sessions, tasks: decryptedTasks, consents, invoices, resources, mustChangePassword: Boolean(account.mustChangePassword), accessorType: account.accessorType };
  }
 
  async saveTaskProgress(portal:any, taskId:string, dto:SaveTaskProgressDto) {
    const task:any=await (this.prisma as any).therapeuticTask.findFirst({where:{id:taskId,patientId:portal.patientId,patient:{workspaceId:portal.workspaceId},status:{in:['PENDING','IN_PROGRESS','CHANGES_REQUESTED']}}});
    if(!task)throw new NotFoundException('Tarea no disponible');
    const now=new Date(); const updated=await (this.prisma as any).therapeuticTask.update({where:{id:taskId},data:{patientFeedback:encryptField(dto.patientFeedback.trim()),status:'IN_PROGRESS',startedAt:task.startedAt||now}});
    await this.prisma.auditLog.create({data:{workspaceId:portal.workspaceId,actorId:null,action:'PORTAL_TASK_PROGRESS_SAVED',entityType:'TherapeuticTask',entityId:taskId,metadata:{patientId:portal.patientId,accessorType:portal.accessorType}}});
    return { ...updated, patientFeedback: decryptField(updated.patientFeedback) ?? null };
  }
 
  async submitTask(portal:any, taskId:string) {
    const task:any=await (this.prisma as any).therapeuticTask.findFirst({where:{id:taskId,patientId:portal.patientId,patient:{workspaceId:portal.workspaceId},status:{in:['IN_PROGRESS','CHANGES_REQUESTED']}}});
    if(!task)throw new BadRequestException('La tarea no puede enviarse en su estado actual');
    if(!decryptField(task.patientFeedback)?.trim())throw new BadRequestException('Añade una respuesta antes de enviar la tarea');
    const updated=await (this.prisma as any).therapeuticTask.update({where:{id:taskId},data:{status:'SUBMITTED',submittedAt:new Date()}});
    await this.prisma.auditLog.create({data:{workspaceId:portal.workspaceId,actorId:null,action:'PORTAL_TASK_SUBMITTED',entityType:'TherapeuticTask',entityId:taskId,metadata:{patientId:portal.patientId,accessorType:portal.accessorType}}});
    return { ...updated, patientFeedback: decryptField(updated.patientFeedback) ?? null };
  }
 
  async changePassword(portal:any, dto:ChangePortalPasswordDto) {
    const account = await (this.prisma as any).patientPortalAccount.findFirst({ where:{ id:portal.portalAccountId, isActive:true } });
    if (!account || !(await bcrypt.compare(dto.currentPassword, account.passwordHash))) throw new BadRequestException('Contraseña actual incorrecta');
    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await (this.prisma as any).patientPortalAccount.update({ where:{ id:account.id }, data:{ passwordHash, mustChangePassword:false } });
    await this.prisma.auditLog.create({ data:{ workspaceId:portal.workspaceId, actorId:null, action:'PORTAL_PASSWORD_CHANGED', entityType:'PatientPortalAccount', entityId:account.id, metadata:{ patientId:portal.patientId } } });
    return { ok:true };
  }
}
 
