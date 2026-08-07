import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { SendMessageDto, UpdateConversationDto } from './dto/message.dto';

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}
  private p() { return this.prisma as any; }

  private assertClinicalRole(actor: AuthUser) {
    if (!['OWNER', 'ADMIN', 'THERAPIST'].includes(actor.role)) throw new ForbiddenException('No tienes acceso a mensajería clínica');
  }

  private async assertPatientAccess(workspaceId: string, actor: AuthUser, patientId: string) {
    this.assertClinicalRole(actor);
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, workspaceId, deletedAt: null } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    if (actor.role === 'THERAPIST') {
      const assigned = await this.prisma.clinicalProcess.findFirst({ where: { workspaceId, patientId, therapistId: actor.sub } });
      if (!assigned) throw new NotFoundException('Paciente no encontrado');
    }
    return patient;
  }

  private validateAttachment(dto: SendMessageDto) {
    const values = [dto.attachmentName, dto.attachmentKey, dto.mimeType];
    const supplied = values.filter(Boolean).length;
    if (supplied > 0 && supplied < 3) throw new BadRequestException('El adjunto requiere nombre, referencia segura y tipo de archivo');
    if (!supplied) return;
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png']);
    if (!allowed.has(dto.mimeType!)) throw new BadRequestException('Tipo de archivo no permitido');
  }

  private conversationSelect() {
    return {
      id: true, status: true, patientCanReply: true, closedAt: true, archivedAt: true, createdAt: true, updatedAt: true,
      patient: { select: { id: true, firstName: true, lastName: true, status: true } },
      messages: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { id: true, body: true, senderType: true, createdAt: true, readByProfessionalAt: true, readByPatientAt: true } },
      _count: { select: { messages: true } },
    };
  }

  async list(workspaceId: string, actor: AuthUser, q?: string) {
    this.assertClinicalRole(actor);
    const where: any = { workspaceId, status: { not: 'ARCHIVED' } };
    if (q?.trim()) where.patient = { OR: [{ firstName: { contains: q.trim(), mode: 'insensitive' } }, { lastName: { contains: q.trim(), mode: 'insensitive' } }] };
    if (actor.role === 'THERAPIST') where.patient = { ...(where.patient || {}), clinicalProcesses: { some: { therapistId: actor.sub } } };
    const rows = await this.p().conversation.findMany({ where, orderBy: { updatedAt: 'desc' }, select: this.conversationSelect() });
    if (!rows.length) return [];
    const unread = await this.p().message.findMany({
      where: { conversationId: { in: rows.map((row: any) => row.id) }, senderType: 'PATIENT', readByProfessionalAt: null },
      select: { conversationId: true },
    });
    const counts = unread.reduce((map: Map<string, number>, item: any) => map.set(item.conversationId, (map.get(item.conversationId) || 0) + 1), new Map<string, number>());
    return rows.map((row: any) => ({ ...row, unreadCount: counts.get(row.id) || 0 }));
  }

  async getOrCreate(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.assertPatientAccess(workspaceId, actor, patientId);
    return this.p().conversation.upsert({
      where: { workspaceId_patientId: { workspaceId, patientId } },
      create: { workspaceId, patientId },
      update: { archivedAt: null, status: 'OPEN' },
      select: this.conversationSelect(),
    });
  }

  async thread(workspaceId: string, actor: AuthUser, conversationId: string) {
    this.assertClinicalRole(actor);
    const conversation = await this.p().conversation.findFirst({
      where: { id: conversationId, workspaceId, status: { not: 'ARCHIVED' } },
      include: { patient: { select: { id: true, firstName: true, lastName: true, status: true } }, messages: { orderBy: { createdAt: 'asc' }, select: { id: true, senderType: true, senderUserId: true, body: true, attachmentName: true, mimeType: true, createdAt: true, readByProfessionalAt: true, readByPatientAt: true } } },
    });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    await this.assertPatientAccess(workspaceId, actor, conversation.patientId);
    await this.p().message.updateMany({ where: { conversationId, senderType: 'PATIENT', readByProfessionalAt: null }, data: { readByProfessionalAt: new Date() } });
    return conversation;
  }

  async send(workspaceId: string, actor: AuthUser, conversationId: string, dto: SendMessageDto) {
    this.assertClinicalRole(actor);
    this.validateAttachment(dto);
    const conversation = await this.p().conversation.findFirst({ where: { id: conversationId, workspaceId } });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    await this.assertPatientAccess(workspaceId, actor, conversation.patientId);
    if (conversation.status !== 'OPEN') throw new BadRequestException('La conversación está cerrada');
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('El mensaje no puede estar vacío');
    const message = await this.p().message.create({ data: { conversationId, senderType: 'PROFESSIONAL', senderUserId: actor.sub, body, attachmentName: dto.attachmentName, attachmentKey: dto.attachmentKey, mimeType: dto.mimeType, readByProfessionalAt: new Date() } });
    await this.p().conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    await this.p().notification.createMany({ data: [{ workspaceId, audience: 'PATIENT', patientId: conversation.patientId, type: 'SYSTEM', title: 'Nuevo mensaje', body: 'Tienes un nuevo mensaje de tu profesional.', actionUrl: '/portal', status: 'SENT', scheduledAt: new Date(), sentAt: new Date(), dedupeKey: `message:${message.id}:patient` }], skipDuplicates: true });
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'MESSAGE_SENT', entityType: 'Message', entityId: message.id, metadata: { conversationId, patientId: conversation.patientId, hasAttachment: Boolean(dto.attachmentKey) } } });
    return message;
  }

  async update(workspaceId: string, actor: AuthUser, conversationId: string, dto: UpdateConversationDto) {
    this.assertClinicalRole(actor);
    const conversation = await this.p().conversation.findFirst({ where: { id: conversationId, workspaceId } });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    await this.assertPatientAccess(workspaceId, actor, conversation.patientId);
    const data: any = {};
    if (dto.patientCanReply !== undefined) data.patientCanReply = dto.patientCanReply;
    if (dto.status) {
      data.status = dto.status;
      data.closedAt = dto.status === 'CLOSED' ? new Date() : null;
      data.archivedAt = dto.status === 'ARCHIVED' ? new Date() : null;
    }
    const updated = await this.p().conversation.update({ where: { id: conversationId }, data });
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CONVERSATION_UPDATED', entityType: 'Conversation', entityId: conversationId, metadata: { status: updated.status, patientCanReply: updated.patientCanReply } } });
    return updated;
  }

  async portalThread(portal: any) {
    const conversation = await this.p().conversation.findFirst({ where: { workspaceId: portal.workspaceId, patientId: portal.patientId, status: { not: 'ARCHIVED' } }, include: { messages: { orderBy: { createdAt: 'asc' }, select: { id: true, senderType: true, body: true, attachmentName: true, mimeType: true, createdAt: true, readByPatientAt: true } } } });
    if (!conversation) return null;
    await this.p().message.updateMany({ where: { conversationId: conversation.id, senderType: 'PROFESSIONAL', readByPatientAt: null }, data: { readByPatientAt: new Date() } });
    return conversation;
  }

  async portalSend(portal: any, dto: SendMessageDto) {
    this.validateAttachment(dto);
    const conversation = await this.p().conversation.findFirst({ where: { workspaceId: portal.workspaceId, patientId: portal.patientId } });
    if (!conversation) throw new NotFoundException('Conversación no disponible');
    if (conversation.status !== 'OPEN' || !conversation.patientCanReply) throw new ForbiddenException('La mensajería está cerrada por tu profesional');
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('El mensaje no puede estar vacío');
    const message = await this.p().message.create({ data: { conversationId: conversation.id, senderType: 'PATIENT', body, attachmentName: dto.attachmentName, attachmentKey: dto.attachmentKey, mimeType: dto.mimeType, readByPatientAt: new Date() } });
    await this.p().conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    const processes = await this.prisma.clinicalProcess.findMany({ where: { workspaceId: portal.workspaceId, patientId: portal.patientId, status: 'ACTIVE' }, select: { therapistId: true } });
    const recipients = [...new Set(processes.map((process: any) => process.therapistId).filter(Boolean))];
    if (recipients.length) await this.p().notification.createMany({ data: recipients.map((userId: string) => ({ workspaceId: portal.workspaceId, audience: 'PROFESSIONAL', userId, type: 'SYSTEM', title: 'Nuevo mensaje de paciente', body: 'Un paciente ha enviado un mensaje.', actionUrl: `/messages?patientId=${portal.patientId}`, status: 'SENT', scheduledAt: new Date(), sentAt: new Date(), dedupeKey: `message:${message.id}:professional:${userId}` })), skipDuplicates: true });
    await this.prisma.auditLog.create({ data: { workspaceId: portal.workspaceId, actorId: null, action: 'PATIENT_MESSAGE_SENT', entityType: 'Message', entityId: message.id, metadata: { conversationId: conversation.id, patientId: portal.patientId, hasAttachment: Boolean(dto.attachmentKey) } } });
    return message;
  }
}
