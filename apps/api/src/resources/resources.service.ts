import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { CreateResourceDto, UpdateResourceDto } from './dto/resource.dto';

@Injectable()
export class ResourcesService {
  constructor(private readonly prisma: PrismaService) {}

  private assertProfessional(actor: AuthUser) {
    if (actor.role === 'ASSISTANT') throw new ForbiddenException('No tienes acceso a recursos terapéuticos');
  }

  private async assertPatientAccess(workspaceId: string, actor: AuthUser, patientId: string) {
    this.assertProfessional(actor);
    const patient = await this.prisma.patient.findFirst({
      where: {
        id: patientId,
        workspaceId,
        deletedAt: null,
        ...(actor.role === 'THERAPIST'
          ? { clinicalProcesses: { some: { workspaceId, therapistId: actor.sub } } }
          : {}),
      },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
  }

  async list(workspaceId: string, actor: AuthUser, query?: string) {
    this.assertProfessional(actor);
    return (this.prisma as any).therapeuticResource.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        ...(query ? { title: { contains: query, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
      include: { _count: { select: { shares: { where: { revokedAt: null } } } } },
    });
  }

  async create(workspaceId: string, actor: AuthUser, dto: CreateResourceDto) {
    this.assertProfessional(actor);
    const resource = await (this.prisma as any).therapeuticResource.create({
      data: { workspaceId, createdById: actor.sub, ...dto },
    });
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'RESOURCE_CREATED', entityType: 'TherapeuticResource', entityId: resource.id, metadata: { type: dto.type, category: dto.category } } });
    return resource;
  }

  async update(workspaceId: string, actor: AuthUser, id: string, dto: UpdateResourceDto) {
    this.assertProfessional(actor);
    const resource = await (this.prisma as any).therapeuticResource.findFirst({ where: { id, workspaceId, archivedAt: null } });
    if (!resource) throw new NotFoundException('Recurso no encontrado');
    const updated = await (this.prisma as any).therapeuticResource.update({ where: { id }, data: dto });
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'RESOURCE_UPDATED', entityType: 'TherapeuticResource', entityId: id } });
    return updated;
  }

  async archive(workspaceId: string, actor: AuthUser, id: string) {
    this.assertProfessional(actor);
    const resource = await (this.prisma as any).therapeuticResource.findFirst({ where: { id, workspaceId, archivedAt: null } });
    if (!resource) throw new NotFoundException('Recurso no encontrado');
    await this.prisma.$transaction([
      (this.prisma as any).therapeuticResource.update({ where: { id }, data: { archivedAt: new Date() } }),
      (this.prisma as any).resourceShare.updateMany({ where: { resourceId: id, workspaceId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'RESOURCE_ARCHIVED', entityType: 'TherapeuticResource', entityId: id } });
    return { ok: true };
  }

  async listForPatient(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.assertPatientAccess(workspaceId, actor, patientId);
    return (this.prisma as any).resourceShare.findMany({
      where: { workspaceId, patientId, revokedAt: null, resource: { archivedAt: null } },
      orderBy: { sharedAt: 'desc' },
      include: { resource: true },
    });
  }

  async share(workspaceId: string, actor: AuthUser, patientId: string, resourceId: string) {
    await this.assertPatientAccess(workspaceId, actor, patientId);
    const resource = await (this.prisma as any).therapeuticResource.findFirst({ where: { id: resourceId, workspaceId, archivedAt: null } });
    if (!resource) throw new NotFoundException('Recurso no encontrado');
    const share = await (this.prisma as any).resourceShare.upsert({
      where: { resourceId_patientId: { resourceId, patientId } },
      create: { workspaceId, resourceId, patientId },
      update: { revokedAt: null, sharedAt: new Date() },
      include: { resource: true },
    });
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'RESOURCE_SHARED', entityType: 'ResourceShare', entityId: share.id, metadata: { patientId, resourceId } } });
    return share;
  }

  async revoke(workspaceId: string, actor: AuthUser, patientId: string, resourceId: string) {
    await this.assertPatientAccess(workspaceId, actor, patientId);
    const share = await (this.prisma as any).resourceShare.findFirst({ where: { workspaceId, patientId, resourceId, revokedAt: null } });
    if (!share) throw new NotFoundException('Recurso compartido no encontrado');
    await (this.prisma as any).resourceShare.update({ where: { id: share.id }, data: { revokedAt: new Date() } });
    await this.prisma.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'RESOURCE_REVOKED', entityType: 'ResourceShare', entityId: share.id, metadata: { patientId, resourceId } } });
    return { ok: true };
  }
}
