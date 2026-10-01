import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { encryptField } from '../common/crypto/field-encryption';
import { decryptMessage } from '../common/crypto/clinical-crypto';
import { SendMessageDto, UpdateConversationDto } from './dto/message.dto';
import { ClinicalAccessService, ClinicalScope, messageWindowFilter } from '../clinical-access/clinical-access.service';

/**
 * Los mensajes con el paciente son CONTENIDO CLÍNICO: solo los lee quien le trata, y solo los de
 * SU tratamiento (ventanas de sus procesos). OWNER/ADMIN que no tratan al paciente ven como mucho
 * metadatos: que existe la conversación, su estado y la fecha de su última actividad. Nunca
 * cuerpo, adjuntos, número de mensajes ni número de no leídos.
 */
const CONVERSATION_METADATA_SELECT = {
  id: true, status: true, patientCanReply: true, closedAt: true, archivedAt: true, createdAt: true, updatedAt: true,
  patient: { select: { id: true, firstName: true, lastName: true, status: true } },
} as const;

@Injectable()
export class MessagesService {
  private readonly access: ClinicalAccessService;

  constructor(private readonly prisma: PrismaService, @Optional() access?: ClinicalAccessService) {
    this.access = access ?? new ClinicalAccessService(prisma);
  }
  private p() { return this.prisma as any; }

  private assertClinicalRole(actor: AuthUser) {
    if (!['OWNER', 'ADMIN', 'THERAPIST'].includes(actor.role)) throw new ForbiddenException('No tienes acceso a mensajería clínica');
  }

  /** Escribir o gestionar la conversación: solo quien trata al paciente (proceso ACTIVO). */
  private async assertTreating(workspaceId: string, actor: AuthUser, patientId: string, resource: string) {
    this.assertClinicalRole(actor);
    const { patient, scope } = await this.access.assertTreating(workspaceId, actor, patientId, resource);
    if (patient.deletedAt) throw new NotFoundException('Paciente no encontrado');
    return { patient, scope };
  }

  /** Leer la conversación: quien trata (sus ventanas) o autor de un proceso cerrado (las suyas). */
  private async assertCanRead(workspaceId: string, actor: AuthUser, patientId: string) {
    this.assertClinicalRole(actor);
    const { patient, scope } = await this.access.assertCanRead(workspaceId, actor, patientId, 'patient-messages');
    if (patient.deletedAt) throw new NotFoundException('Paciente no encontrado');
    return { patient, scope };
  }

  private validateAttachment(dto: SendMessageDto) {
    const values = [dto.attachmentName, dto.attachmentKey, dto.mimeType];
    const supplied = values.filter(Boolean).length;
    if (supplied > 0 && supplied < 3) throw new BadRequestException('El adjunto requiere nombre, referencia segura y tipo de archivo');
    if (!supplied) return;
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png']);
    if (!allowed.has(dto.mimeType!)) throw new BadRequestException('Tipo de archivo no permitido');
  }

  /** Conversación con la vista previa del último mensaje DENTRO de las ventanas del actor. */
  private conversationSelect(scope: ClinicalScope) {
    return {
      ...CONVERSATION_METADATA_SELECT,
      messages: { where: messageWindowFilter(scope), orderBy: { createdAt: 'desc' as const }, take: 1, select: { id: true, body: true, senderType: true, createdAt: true, readByProfessionalAt: true, readByPatientAt: true } },
    };
  }

  // body y attachmentName se cifran en reposo (lista única en common/crypto/clinical-crypto.ts).
  // list() (vista previa), thread()/portalThread() y las respuestas de send() descifran igual.
  private decryptMessage<T extends Record<string, any>>(message: T): T {
    return decryptMessage(message);
  }

  async list(workspaceId: string, actor: AuthUser, q?: string) {
    this.assertClinicalRole(actor);
    const where: any = { workspaceId, status: { not: 'ARCHIVED' } };
    if (q?.trim()) where.patient = { OR: [{ firstName: { contains: q.trim(), mode: 'insensitive' } }, { lastName: { contains: q.trim(), mode: 'insensitive' } }] };
    if (actor.role === 'THERAPIST') where.patient = { ...(where.patient || {}), clinicalProcesses: { some: { workspaceId, therapistId: actor.sub } } };
    const rows = await this.p().conversation.findMany({ where, orderBy: { updatedAt: 'desc' }, select: CONVERSATION_METADATA_SELECT });
    if (!rows.length) return [];

    // Vista previa y no leídos solo en las conversaciones de pacientes que trata ahora mismo, y
    // solo con mensajes de sus ventanas. El resto: metadatos.
    const { treatingPatientIds } = await this.access.listingContext(workspaceId, actor);
    const result = [];
    for (const row of rows) {
      const metadata = { ...row, lastActivityAt: row.updatedAt, canReadMessages: false, messages: [] as any[], unreadCount: null as number | null };
      if (!treatingPatientIds.has(row.patient.id)) { result.push(metadata); continue; }
      const scope = await this.access.resolveScope(workspaceId, actor, row.patient.id);
      if (!scope || scope.level !== 'TREATING') { result.push(metadata); continue; }
      const windowFilter = messageWindowFilter(scope);
      const [last, unreadCount] = await Promise.all([
        this.p().message.findMany({ where: { conversationId: row.id, ...windowFilter }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, body: true, senderType: true, createdAt: true, readByProfessionalAt: true, readByPatientAt: true } }),
        this.p().message.count({ where: { conversationId: row.id, senderType: 'PATIENT', readByProfessionalAt: null, ...windowFilter } }),
      ]);
      result.push({ ...metadata, canReadMessages: true, messages: last.map((message: any) => this.decryptMessage(message)), unreadCount });
    }
    return result;
  }

  async getOrCreate(workspaceId: string, actor: AuthUser, patientId: string) {
    const { scope } = await this.assertTreating(workspaceId, actor, patientId, 'patient-messages-open');
    const conversation = await this.p().conversation.upsert({
      where: { workspaceId_patientId: { workspaceId, patientId } },
      create: { workspaceId, patientId },
      update: { archivedAt: null, status: 'OPEN' },
      select: this.conversationSelect(scope),
    });
    return { ...conversation, messages: conversation.messages.map((message: any) => this.decryptMessage(message)) };
  }

  async thread(workspaceId: string, actor: AuthUser, conversationId: string) {
    this.assertClinicalRole(actor);
    // Primero solo metadatos (sin mensajes): el contenido se carga DESPUÉS de decidir el acceso.
    const conversation = await this.p().conversation.findFirst({
      where: { id: conversationId, workspaceId, status: { not: 'ARCHIVED' } },
      select: { id: true, workspaceId: true, patientId: true, status: true, patientCanReply: true, closedAt: true, archivedAt: true, createdAt: true, updatedAt: true, patient: { select: { id: true, firstName: true, lastName: true, status: true } } },
    });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    const { scope } = await this.assertCanRead(workspaceId, actor, conversation.patientId);
    const windowFilter = messageWindowFilter(scope);
    const messages = await this.p().message.findMany({
      where: { conversationId, ...windowFilter },
      orderBy: { createdAt: 'asc' },
      select: { id: true, senderType: true, senderUserId: true, body: true, attachmentName: true, mimeType: true, createdAt: true, readByProfessionalAt: true, readByPatientAt: true },
    });
    // Solo quien trata marca como leídos, y solo los mensajes de sus ventanas.
    if (scope.level === 'TREATING') {
      await this.p().message.updateMany({ where: { conversationId, senderType: 'PATIENT', readByProfessionalAt: null, ...windowFilter }, data: { readByProfessionalAt: new Date() } });
    }
    return { ...conversation, readOnly: scope.level !== 'TREATING', messages: messages.map((message: any) => this.decryptMessage(message)) };
  }

  async send(workspaceId: string, actor: AuthUser, conversationId: string, dto: SendMessageDto) {
    this.assertClinicalRole(actor);
    this.validateAttachment(dto);
    const conversation = await this.p().conversation.findFirst({ where: { id: conversationId, workspaceId } });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    await this.assertTreating(workspaceId, actor, conversation.patientId, 'patient-messages-send');
    if (conversation.status !== 'OPEN') throw new BadRequestException('La conversación está cerrada');
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('El mensaje no puede estar vacío');
    const message = await this.p().message.create({ data: { conversationId, senderType: 'PROFESSIONAL', senderUserId: actor.sub, body: encryptField(body)!, attachmentName: encryptField(dto.attachmentName), attachmentKey: dto.attachmentKey, mimeType: dto.mimeType, readByProfessionalAt: new Date() } });
    await this.p().conversation.updateMany({ where: { id: conversationId, workspaceId }, data: { updatedAt: new Date() } });
    await this.p().notification.createMany({ data: [{ workspaceId, audience: 'PATIENT', patientId: conversation.patientId, type: 'SYSTEM', title: 'Nuevo mensaje', body: 'Tienes un nuevo mensaje de tu profesional.', actionUrl: '/portal', status: 'SENT', scheduledAt: new Date(), sentAt: new Date(), dedupeKey: `message:${message.id}:patient` }], skipDuplicates: true });
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'MESSAGE_SENT', entityType: 'Message', entityId: message.id, metadata: { conversationId, patientId: conversation.patientId, hasAttachment: Boolean(dto.attachmentKey) } } });
    return this.decryptMessage(message);
  }

  async update(workspaceId: string, actor: AuthUser, conversationId: string, dto: UpdateConversationDto) {
    this.assertClinicalRole(actor);
    const conversation = await this.p().conversation.findFirst({ where: { id: conversationId, workspaceId } });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    await this.assertTreating(workspaceId, actor, conversation.patientId, 'patient-messages-manage');
    const data: any = {};
    if (dto.patientCanReply !== undefined) data.patientCanReply = dto.patientCanReply;
    if (dto.status) {
      data.status = dto.status;
      data.closedAt = dto.status === 'CLOSED' ? new Date() : null;
      data.archivedAt = dto.status === 'ARCHIVED' ? new Date() : null;
    }
    // Escritura acotada al workspace (nunca solo por id).
    const { count } = await this.p().conversation.updateMany({ where: { id: conversationId, workspaceId }, data });
    if (count === 0) throw new NotFoundException('Conversación no encontrada');
    const updated = await this.p().conversation.findFirst({ where: { id: conversationId, workspaceId }, select: { id: true, status: true, patientCanReply: true, closedAt: true, archivedAt: true, createdAt: true, updatedAt: true } });
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'CONVERSATION_UPDATED', entityType: 'Conversation', entityId: conversationId, metadata: { status: updated.status, patientCanReply: updated.patientCanReply } } });
    return updated;
  }

  async portalThread(portal: any) {
    const conversation = await this.p().conversation.findFirst({ where: { workspaceId: portal.workspaceId, patientId: portal.patientId, status: { not: 'ARCHIVED' } }, include: { messages: { orderBy: { createdAt: 'asc' }, select: { id: true, senderType: true, body: true, attachmentName: true, mimeType: true, createdAt: true, readByPatientAt: true } } } });
    if (!conversation) return null;
    await this.p().message.updateMany({ where: { conversationId: conversation.id, senderType: 'PROFESSIONAL', readByPatientAt: null }, data: { readByPatientAt: new Date() } });
    return { ...conversation, messages: conversation.messages.map((message: any) => this.decryptMessage(message)) };
  }

  async portalSend(portal: any, dto: SendMessageDto) {
    this.validateAttachment(dto);
    const conversation = await this.p().conversation.findFirst({ where: { workspaceId: portal.workspaceId, patientId: portal.patientId } });
    if (!conversation) throw new NotFoundException('Conversación no disponible');
    if (conversation.status !== 'OPEN' || !conversation.patientCanReply) throw new ForbiddenException('La mensajería está cerrada por tu profesional');
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('El mensaje no puede estar vacío');
    const message = await this.p().message.create({ data: { conversationId: conversation.id, senderType: 'PATIENT', body: encryptField(body)!, attachmentName: encryptField(dto.attachmentName), attachmentKey: dto.attachmentKey, mimeType: dto.mimeType, readByPatientAt: new Date() } });
    await this.p().conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    const processes = await this.prisma.clinicalProcess.findMany({ where: { workspaceId: portal.workspaceId, patientId: portal.patientId, status: 'ACTIVE' }, select: { therapistId: true } });
    const recipients = [...new Set(processes.map((process: any) => process.therapistId).filter(Boolean))];
    if (recipients.length) await this.p().notification.createMany({ data: recipients.map((userId: string) => ({ workspaceId: portal.workspaceId, audience: 'PROFESSIONAL', userId, type: 'SYSTEM', title: 'Nuevo mensaje de paciente', body: 'Un paciente ha enviado un mensaje.', actionUrl: `/messages?patientId=${portal.patientId}`, status: 'SENT', scheduledAt: new Date(), sentAt: new Date(), dedupeKey: `message:${message.id}:professional:${userId}` })), skipDuplicates: true });
    await this.prisma.auditLog.create({ data: { workspaceId: portal.workspaceId, actorId: null, action: 'PATIENT_MESSAGE_SENT', entityType: 'Message', entityId: message.id, metadata: { conversationId: conversation.id, patientId: portal.patientId, hasAttachment: Boolean(dto.attachmentKey) } } });
    return this.decryptMessage(message);
  }
}
