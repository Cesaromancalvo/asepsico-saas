import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { decryptField, encryptField } from '../common/crypto/field-encryption';
import { ChangePortalPasswordDto, EnablePortalDto, PortalLoginDto } from './dto/portal.dto';
import { SaveTaskProgressDto } from './dto/task-response.dto';
import { accessModesAllowing, isAccessorAllowed } from './portal-access-mode.util';

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
    const email = dto.email.toLowerCase().trim();
    const accessorType = dto.accessorType ?? 'PATIENT';

    // El modo de acceso lo decide el profesional (p. ej. un menor con PATIENT_ONLY no puede
    // tener cuenta de tutor). Se comprueba antes de tocar ninguna cuenta.
    if (!isAccessorAllowed((patient as any).portalAccessMode, accessorType)) {
      await this.auditEnableRejected(workspaceId, actor, patientId, accessorType, 'ACCESS_MODE_NOT_ALLOWED', (patient as any).portalAccessMode);
      throw new BadRequestException(
        accessorType === 'GUARDIAN'
          ? 'El modo de acceso al portal de este paciente no admite cuentas de tutor'
          : 'El modo de acceso al portal de este paciente no admite cuenta del propio paciente',
      );
    }

    const existing = await (this.prisma as any).patientPortalAccount.findUnique({ where: { email } });
    if (existing && (existing.patientId !== patientId || existing.workspaceId !== workspaceId)) {
      // Mensaje genérico: no revela que el correo pertenece a otro paciente ni a otra consulta.
      throw new BadRequestException('Ese correo no puede usarse para esta cuenta de portal; indica otro correo');
    }
    // Reactivar un correo no puede cambiar quién es la cuenta (paciente ↔ tutor): eso
    // convertiría una cuenta revocada por el modo de acceso en otra de distinto tipo.
    if (existing && existing.accessorType !== accessorType) {
      await this.auditEnableRejected(workspaceId, actor, patientId, accessorType, 'ACCESSOR_TYPE_MISMATCH', (patient as any).portalAccessMode);
      throw new BadRequestException('Ese correo ya pertenece a una cuenta de portal de otro tipo (paciente/tutor); usa otro correo');
    }

    const passwordHash = await bcrypt.hash(dto.temporaryPassword, 12);
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

    const select = { id:true, patientId:true, email:true, accessorType:true, guardianName:true, guardianRelationship:true, isActive:true, mustChangePassword:true, createdAt:true, updatedAt:true };
    return this.prisma.$transaction(async (tx: any) => {
      // Compare-and-set sobre el paciente: el modo leído arriba debe seguir admitiendo este tipo
      // de cuenta al escribir. El UPDATE además bloquea la fila hasta el commit, así que un cambio
      // de portalAccessMode concurrente (que escribe esa misma fila) o ya se ve aquí (count 0 →
      // 409) o espera y después revoca la cuenta recién creada.
      const { count: modeStillAllows } = await tx.patient.updateMany({
        where: { id: patientId, workspaceId, deletedAt: null, portalAccessMode: { in: accessModesAllowing(accessorType) } },
        data: { updatedAt: new Date() },
      });
      if (!modeStillAllows) {
        throw new ConflictException('El modo de acceso al portal del paciente ha cambiado; recarga y vuelve a intentarlo');
      }

      let account: any;
      if (existing) {
        // Reactivación: acotada al workspace y al paciente, nunca solo por id.
        const scope = { id: existing.id, workspaceId, patientId };
        const { count } = await tx.patientPortalAccount.updateMany({ where: scope, data: accountData });
        if (!count) throw new NotFoundException('Cuenta de portal no encontrada');
        account = await tx.patientPortalAccount.findFirst({ where: scope, select });
      } else {
        account = await tx.patientPortalAccount.create({ data: { workspaceId, patientId, email, ...accountData }, select });
      }
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action:'PORTAL_ACCOUNT_ENABLED', entityType:'PatientPortalAccount', entityId:account.id, metadata:{ patientId, accessorType } } });
      return account;
    });
  }

  // Sin emails ni nombres de tutor en la metadata: solo ids, tipo de cuenta, modo y motivo.
  private async auditEnableRejected(workspaceId: string, actor: any, patientId: string, accessorType: string, reason: string, portalAccessMode: string) {
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action:'PORTAL_ACCOUNT_ENABLE_REJECTED', entityType:'Patient', entityId:patientId, metadata:{ patientId, accessorType, portalAccessMode, reason } } });
  }

  async disable(workspaceId: string, actor: any, patientId: string) {
    this.assertStaff(actor);
    await this.prisma.$transaction(async (tx: any) => {
      const result = await tx.patientPortalAccount.updateMany({ where:{ patientId, workspaceId }, data:{ isActive:false } });
      if (!result.count) throw new NotFoundException();
      await tx.auditLog.create({ data:{ workspaceId, actorId:actor.sub, action:'PORTAL_ACCOUNT_DISABLED', entityType:'PatientPortalAccount', entityId:patientId, metadata:{ patientId } } });
    });
    return { ok:true };
  }

  async login(dto: PortalLoginDto) {
    const email = dto.email.toLowerCase().trim();
    const account = await (this.prisma as any).patientPortalAccount.findFirst({ where:{ email, isActive:true }, include:{ patient:{ select:{ id:true, firstName:true, lastName:true, status:true } } } });
    if (!account) throw new UnauthorizedException('Credenciales incorrectas');
    if (account.lockedUntil && account.lockedUntil > new Date()) throw new UnauthorizedException('Cuenta temporalmente bloqueada');
    const valid = await bcrypt.compare(dto.password, account.passwordHash);
    // Escrituras acotadas al workspace de la propia cuenta (nunca solo por id).
    const accountScope = { id: account.id, workspaceId: account.workspaceId, patientId: account.patientId };
    if (!valid) {
      const attempts = account.failedLoginAttempts + 1;
      await (this.prisma as any).patientPortalAccount.updateMany({ where:accountScope, data:{ failedLoginAttempts: attempts, lockedUntil: attempts >= 5 ? new Date(Date.now()+15*60_000) : null } });
      throw new UnauthorizedException('Credenciales incorrectas');
    }
    await (this.prisma as any).patientPortalAccount.updateMany({ where:accountScope, data:{ failedLoginAttempts:0, lockedUntil:null, lastLoginAt:new Date() } });
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
      (this.prisma as any).therapeuticTask.findMany({ where:{ patientId:portal.patientId, patient:{ workspaceId:portal.workspaceId }, status:{ in:['PENDING','IN_PROGRESS','CHANGES_REQUESTED','SUBMITTED','COMPLETED'] } }, orderBy:[{ dueDate:'asc' },{ createdAt:'desc' }], select:{ id:true,title:true,instructions:true,status:true,dueDate:true,patientFeedback:true,reviewComment:true,submittedAt:true,completedAt:true,updatedAt:true } }),
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
      (this.prisma as any).therapeuticTask.findMany({ where:{ patientId:portal.patientId, patient:{ workspaceId:portal.workspaceId } }, orderBy:{ createdAt:'asc' }, select:{ title:true, instructions:true, status:true, dueDate:true, patientFeedback:true, submittedAt:true, completedAt:true } }),
      (this.prisma as any).clinicalAssessment.findMany({ where:{ patientId:portal.patientId, patient:{ workspaceId:portal.workspaceId } }, orderBy:{ administeredAt:'asc' }, select:{ scaleName:true, totalScore:true, severity:true, administeredAt:true } }),
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
    // El motivo es texto libre del paciente y puede contener datos de salud: NO se persiste en
    // claro (ni en la auditoría ni en la notificación). Solo se registra si se indicó.
    const hasReason = Boolean(reason?.trim());
    const requestId = randomUUID();
    // Auditoría y avisos en la misma transacción: o quedan todos o ninguno.
    await this.prisma.$transaction(async (tx: any) => {
      await tx.auditLog.create({ data:{ workspaceId:portal.workspaceId, actorId:null, action:'PORTAL_DELETION_REQUESTED', entityType:'Patient', entityId:portal.patientId, metadata:{ accessorType:portal.accessorType, hasReason } } });

      // Destinatarios: OWNER/ADMIN del workspace + terapeutas con proceso ACTIVO del paciente.
      // listProfessional filtra por userId, así que cada aviso va dirigido a un usuario concreto.
      const [managers, processes] = await Promise.all([
        tx.workspaceMember.findMany({ where:{ workspaceId:portal.workspaceId, role:{ in:['OWNER','ADMIN'] } }, select:{ userId:true } }),
        tx.clinicalProcess.findMany({ where:{ workspaceId:portal.workspaceId, patientId:portal.patientId, status:'ACTIVE' }, select:{ therapistId:true } }),
      ]);
      const recipients = [...new Set<string>([
        ...managers.map((m: any) => m.userId),
        ...processes.map((p: any) => p.therapistId),
      ].filter(Boolean))];
      const now = new Date();
      for (const userId of recipients) {
        await tx.notification.create({ data: {
          workspaceId: portal.workspaceId,
          audience: 'PROFESSIONAL',
          userId,
          patientId: portal.patientId,
          type: 'SYSTEM',
          title: 'Solicitud de baja de datos',
          body: 'El paciente (o su tutor) ha solicitado la baja/borrado de sus datos. Revisa la solicitud en la ficha del paciente.',
          actionUrl: `/patients/${portal.patientId}`,
          status: 'SENT',
          scheduledAt: now,
          sentAt: now,
          dedupeKey: `deletion-request:${requestId}:${userId}`,
        }});
      }
    });

    return { ok: true };
  }

  /** Alcance de una tarea del paciente autenticado: su patientId y el workspace del token. */
  private portalTaskScope(portal: any, taskId: string) {
    return { id: taskId, patientId: portal.patientId, patient: { workspaceId: portal.workspaceId } };
  }

  async saveTaskProgress(portal:any, taskId:string, dto:SaveTaskProgressDto) {
    const scope = this.portalTaskScope(portal, taskId);
    const editable = ['PENDING','IN_PROGRESS','CHANGES_REQUESTED'];
    const task:any=await (this.prisma as any).therapeuticTask.findFirst({where:{...scope,status:{in:editable}}});
    if(!task)throw new NotFoundException('Tarea no disponible');
    const now=new Date();
    const updated:any = await this.prisma.$transaction(async (tx: any) => {
      // El estado se vuelve a exigir en la escritura (compare-and-set) junto con el alcance.
      const { count } = await tx.therapeuticTask.updateMany({where:{...scope,status:{in:editable}},data:{patientFeedback:encryptField(dto.patientFeedback.trim()),status:'IN_PROGRESS',startedAt:task.startedAt||now}});
      if(!count)throw new NotFoundException('Tarea no disponible');
      await tx.auditLog.create({data:{workspaceId:portal.workspaceId,actorId:null,action:'PORTAL_TASK_PROGRESS_SAVED',entityType:'TherapeuticTask',entityId:taskId,metadata:{patientId:portal.patientId,accessorType:portal.accessorType}}});
      return tx.therapeuticTask.findFirst({where:scope});
    });
    return { ...updated, patientFeedback: decryptField(updated.patientFeedback) ?? null };
  }

  async submitTask(portal:any, taskId:string) {
    const scope = this.portalTaskScope(portal, taskId);
    const submittable = ['IN_PROGRESS','CHANGES_REQUESTED'];
    const task:any=await (this.prisma as any).therapeuticTask.findFirst({where:{...scope,status:{in:submittable}}});
    if(!task)throw new BadRequestException('La tarea no puede enviarse en su estado actual');
    if(!decryptField(task.patientFeedback)?.trim())throw new BadRequestException('Añade una respuesta antes de enviar la tarea');
    const updated:any = await this.prisma.$transaction(async (tx: any) => {
      // Se exige que la respuesta validada siga siendo la guardada (no se envía una tarea vaciada entretanto).
      const { count } = await tx.therapeuticTask.updateMany({where:{...scope,status:{in:submittable},patientFeedback:task.patientFeedback},data:{status:'SUBMITTED',submittedAt:new Date()}});
      if(!count)throw new BadRequestException('La tarea no puede enviarse en su estado actual');
      await tx.auditLog.create({data:{workspaceId:portal.workspaceId,actorId:null,action:'PORTAL_TASK_SUBMITTED',entityType:'TherapeuticTask',entityId:taskId,metadata:{patientId:portal.patientId,accessorType:portal.accessorType}}});
      return tx.therapeuticTask.findFirst({where:scope});
    });
    return { ...updated, patientFeedback: decryptField(updated.patientFeedback) ?? null };
  }

  async changePassword(portal:any, dto:ChangePortalPasswordDto) {
    // Cuenta del token, acotada a su paciente y workspace (lectura y escritura).
    const scope = { id:portal.portalAccountId, patientId:portal.patientId, workspaceId:portal.workspaceId };
    const account = await (this.prisma as any).patientPortalAccount.findFirst({ where:{ ...scope, isActive:true } });
    if (!account || !(await bcrypt.compare(dto.currentPassword, account.passwordHash))) throw new BadRequestException('Contraseña actual incorrecta');
    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction(async (tx: any) => {
      // Se exige el mismo hash validado: si otra petición cambió la contraseña entretanto, no se pisa.
      const { count } = await tx.patientPortalAccount.updateMany({ where:{ ...scope, isActive:true, passwordHash:account.passwordHash }, data:{ passwordHash, mustChangePassword:false } });
      if (!count) throw new BadRequestException('Contraseña actual incorrecta');
      await tx.auditLog.create({ data:{ workspaceId:portal.workspaceId, actorId:null, action:'PORTAL_PASSWORD_CHANGED', entityType:'PatientPortalAccount', entityId:account.id, metadata:{ patientId:portal.patientId } } });
    });
    return { ok:true };
  }
}
