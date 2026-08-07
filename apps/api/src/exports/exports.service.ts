import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';

const CLINICAL_ROLES = ['OWNER', 'ADMIN', 'THERAPIST'];
const ADMIN_ROLES = ['OWNER', 'ADMIN'];

@Injectable()
export class ExportsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertClinical(user: AuthUser) {
    if (!CLINICAL_ROLES.includes(user.role)) throw new ForbiddenException('No tienes permiso para exportar información clínica');
  }

  private assertAdmin(user: AuthUser) {
    if (!ADMIN_ROLES.includes(user.role)) throw new ForbiddenException('Solo propietarios y administradores pueden exportar el workspace');
  }

  private async assertPatientAccess(user: AuthUser, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: {
        id: patientId,
        workspaceId: user.workspaceId,
        deletedAt: null,
        ...(user.role === 'THERAPIST'
          ? { clinicalProcesses: { some: { therapistId: user.sub } } }
          : {}),
      },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
  }

  private async audit(user: AuthUser, action: string, entityType: string, entityId?: string, metadata?: object) {
    await this.prisma.auditLog.create({
      data: { workspaceId: user.workspaceId, actorId: user.sub, action, entityType, entityId, metadata: metadata ?? {} },
    });
  }

  async exportPatient(user: AuthUser, patientId: string) {
    this.assertClinical(user);
    await this.assertPatientAccess(user, patientId);

    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, workspaceId: user.workspaceId, deletedAt: null },
      include: {
        clinicalHistory: true,
        clinicalProcesses: { orderBy: { startedAt: 'desc' } },
        sessions: { orderBy: { startsAt: 'desc' } },
        therapyGoals: { orderBy: { createdAt: 'desc' } },
        therapeuticTasks: { orderBy: { createdAt: 'desc' } },
        clinicalAssessments: { orderBy: { administeredAt: 'desc' } },
        consentRecords: { orderBy: { createdAt: 'desc' } },
        clinicalReports: { orderBy: { createdAt: 'desc' } },
        patientDocuments: { orderBy: { createdAt: 'desc' } },
        invoices: { include: { lines: true, payments: true }, orderBy: { createdAt: 'desc' } },
        resourceShares: { include: { resource: true }, orderBy: { sharedAt: 'desc' } },
      },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');

    const generatedAt = new Date().toISOString();
    await this.audit(user, 'PATIENT_DATA_EXPORTED', 'Patient', patientId, { generatedAt, format: 'JSON' });
    return {
      schemaVersion: '1.0',
      exportType: 'PATIENT_CLINICAL_RECORD',
      generatedAt,
      workspaceId: user.workspaceId,
      patient,
      notice: 'Exportación clínica confidencial. Debe almacenarse y transmitirse de forma segura.',
    };
  }

  async exportWorkspace(user: AuthUser) {
    this.assertAdmin(user);
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: user.workspaceId },
      include: {
        members: { include: { user: { select: { id: true, email: true, firstName: true, lastName: true, createdAt: true } } } },
        patients: { where: { deletedAt: null }, select: { id: true, firstName: true, lastName: true, status: true, createdAt: true, updatedAt: true } },
      },
    });
    if (!workspace) throw new NotFoundException('Workspace no encontrado');

    const [sessions, invoices, resources, conversations, auditLogs] = await Promise.all([
      this.prisma.session.count({ where: { workspaceId: user.workspaceId } }),
      this.prisma.invoice.count({ where: { workspaceId: user.workspaceId } }),
      this.prisma.therapeuticResource.count({ where: { workspaceId: user.workspaceId, archivedAt: null } }),
      this.prisma.conversation.count({ where: { workspaceId: user.workspaceId } }),
      this.prisma.auditLog.findMany({ where: { workspaceId: user.workspaceId }, orderBy: { createdAt: 'desc' }, take: 1000 }),
    ]);
    const generatedAt = new Date().toISOString();
    await this.audit(user, 'WORKSPACE_DATA_EXPORTED', 'Workspace', user.workspaceId, { generatedAt, format: 'JSON' });
    return {
      schemaVersion: '1.0', exportType: 'WORKSPACE_ADMIN_EXPORT', generatedAt,
      workspace: { id: workspace.id, name: workspace.name, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt },
      members: workspace.members,
      patients: workspace.patients,
      inventory: { sessions, invoices, resources, conversations },
      recentAuditLogs: auditLogs,
      notice: 'Esta exportación administrativa no sustituye a una copia de seguridad de PostgreSQL.',
    };
  }

  async getPilotReadiness(user: AuthUser) {
    this.assertAdmin(user);
    const [members, patients, futureSessions, portalAccounts, pendingConsents, overdueInvoices] = await Promise.all([
      this.prisma.workspaceMember.count({ where: { workspaceId: user.workspaceId } }),
      this.prisma.patient.count({ where: { workspaceId: user.workspaceId, deletedAt: null } }),
      this.prisma.session.count({ where: { workspaceId: user.workspaceId, startsAt: { gt: new Date() }, status: 'SCHEDULED' } }),
      this.prisma.patientPortalAccount.count({ where: { workspaceId: user.workspaceId, disabledAt: null } }),
      this.prisma.consentRecord.count({ where: { workspaceId: user.workspaceId, status: 'PENDING' } }),
      this.prisma.invoice.count({ where: { workspaceId: user.workspaceId, status: 'OVERDUE' } }),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      checks: [
        { key: 'team', label: 'Equipo configurado', status: members > 0 ? 'READY' : 'BLOCKED', detail: `${members} miembro(s)` },
        { key: 'patients', label: 'Pacientes de piloto cargados', status: patients > 0 ? 'READY' : 'PENDING', detail: `${patients} paciente(s)` },
        { key: 'agenda', label: 'Agenda preparada', status: futureSessions > 0 ? 'READY' : 'PENDING', detail: `${futureSessions} cita(s) futura(s)` },
        { key: 'portal', label: 'Portal del paciente activado', status: portalAccounts > 0 ? 'READY' : 'PENDING', detail: `${portalAccounts} cuenta(s)` },
        { key: 'consents', label: 'Consentimientos pendientes revisados', status: pendingConsents === 0 ? 'READY' : 'WARNING', detail: `${pendingConsents} pendiente(s)` },
        { key: 'billing', label: 'Facturación sin incidencias vencidas', status: overdueInvoices === 0 ? 'READY' : 'WARNING', detail: `${overdueInvoices} vencida(s)` },
        { key: 'backup', label: 'Backup operativo verificado', status: 'MANUAL', detail: 'Ejecutar scripts/backup-postgres.sh y restore-check.sh' },
      ],
    };
  }
}
