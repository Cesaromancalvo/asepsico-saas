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

  async listAccounts(workspaceId: string, actor: any, patientId: string) {
    this.assertStaff(actor);
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId, deletedAt: null } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    return (this.prisma as any).patientPortalAccount.findMany({
      where: { patientId, workspaceId },
      orderBy: [{ accessorType: 'asc' }, { createdAt: 'asc' }],
      select: { id:true, email:true, accessorType:true, guardianName:true, guardianRelationship:true, isActive:true, mustChangePassword:true, lastLoginAt:true, createdAt:true },
    });
  }

  async enable(workspaceId: string, actor: any, patientId: string, dto: EnablePortalDto) {
    this.assertStaff(actor);
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId, deletedAt: null } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    const passwordHash = await bcrypt.hash(dto.temporaryPassword, 12);
    const email = dto.email.toLowerCase().trim();
    const accessorType = dto.accessorType ?? 'PATIENT';

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
    const decryptedTasks = tasks.map((task: any) => ({
      ...task,
      instructions: decryptField(task.instructions) ?? null,
      patientFeedback: decryptField(task.patientFeedback) ?? null,
      reviewComment: decryptField(task.reviewComment) ?? null,
    }));
    return { patient, sessions, tasks: decryptedTasks, consents, invoices, resources, mustChangePassword: Boolean(account.mustChangePassword), accessorType: account.accessorType };
  }

  /**
   * Exportación de datos propios del paciente (art. 15 RGPD, derecho de acceso): a diferencia
   * de la baja/borrado, esto SÍ se autoserve sin pasar por el profesional — no es una acción
   * destructiva, es solo entregarle al paciente (o a su tutor) una copia de lo que ya puede
   * ver en su propio portal, en un formato descargable.
   */
  async exportData(portal: any) {
    const account = await (this.prisma as any).patientPortalAccount.findFirst({ where:{ id:portal.portalAccountId, patientId:portal.patientId, workspaceId:portal.workspaceId, isActive:true } });
    if (!account) throw new UnauthorizedException();

    const [patient, sessions, tasks, assessments, consents, invoices] = await Promise.all([
      this.prisma.patient.findFirst({ where:{ id:portal.patientId, workspaceId:portal.workspaceId, deletedAt:null }, select:{ id:true, firstName:true, lastName:true, email:true, phone:true, birthDate:true, createdAt:true } }),
      this.prisma.session.findMany({ where:{ patientId:portal.patientId, workspaceId:portal.workspaceId }, orderBy:{ startsAt:'asc' }, select:{ startsAt:true, endsAt:true, status:true, type:true } }),
      (this.prisma as any).therapeuticTask.findMany({ where:{ patientId:portal.patientId }, orderBy:{ createdAt:'asc' }, select:{ title:true, instructions:true, status:true, dueDate:true, patientFeedback:true, submittedAt:true, completedAt:true } }),
      (this.prisma as any).clinicalAssessment.findMany({ where:{ patientId:portal.patientId }, orderBy:{ administeredAt:'asc' }, select:{ scaleName:true, totalScore:true, severity:true, administeredAt:true } }),
      (this.prisma as any).consentRecord.findMany({ where:{ patientId:portal.patientId, workspaceId:portal.workspaceId }, orderBy:{ createdAt:'asc' }, select:{ title:true, type:true, status:true, signedAt:true } }),
      (this.prisma as any).invoice.findMany({ where:{ patientId:portal.patientId, workspaceId:portal.workspaceId, status:{ not:'DRAFT' } }, orderBy:{ createdAt:'asc' }, select:{ invoiceNumber:true, status:true, totalCents:true, paidCents:true, issueDate:true } }),
    ]);
    if (!patient) throw new NotFoundException();

    const decryptedTasks = tasks.map((task: any) => ({
      ...task,
      instructions: decryptField(task.instructions) ?? null,
      patientFeedback: decryptField(task.patientFeedback) ?? null,
    }));

    await this.prisma.auditLog.create({ data:{ workspaceId:portal.workspaceId, actorId:null, action:'PORTAL_DATA_EXPORTED', entityType:'Patient', entityId:portal.patientId, metadata:{ accessorType:portal.accessorType } } });

    return {
      exportedAt: new Date().toISOString(),
      patient,
      sessions,
      tasks: decryptedTasks,
      assessments,
      consents,
      invoices,
    };
  }

  /**
   * Solicitud de baja/borrado: a diferencia de exportData(), esto NUNCA ejecuta nada por sí
   * mismo — solo avisa al profesional (cláusula 9.1 del contrato art. 28: el Encargado
   * traslada la solicitud, no decide sobre el fondo). El profesional revisa y, si procede,
   * actúa manualmente con la acción de bloqueo ya existente.
   */
  async requestDeletion(portal: any, reason?: string) {
    await this.prisma.auditLog.create({ data:{ workspaceId:portal.workspaceId, actorId:null, action:'PORTAL_DELETION_REQUESTED', entityType:'Patient', entityId:portal.patientId, metadata:{ accessorType:portal.accessorType, reason: reason || null } } });

    await (this.prisma as any).notification.create({ data: {
      workspaceId: portal.workspaceId,
      audience: 'PROFESSIONAL',
      patientId: portal.patientId,
      type: 'SYSTEM',
      title: 'Solicitud de baja de datos',
      body: `El paciente (o su tutor) ha solicitado la baja/borrado de sus datos.${reason ? ' Motivo: ' + reason : ''}`,
      status: 'PENDING',
      scheduledAt: new Date(),
      dedupeKey: `deletion-request:${portal.patientId}:${Date.now()}`,
    }});

    return { ok: true };
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
