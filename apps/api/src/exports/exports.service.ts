import { ForbiddenException, Injectable, Logger, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { compare } from 'bcryptjs';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';
import { decryptDeep, decryptPatientRecord } from '../common/crypto/clinical-crypto';
import { ClinicalAccessService } from '../clinical-access/clinical-access.service';

const CLINICAL_ROLES = ['OWNER', 'ADMIN', 'THERAPIST'];
const ADMIN_ROLES = ['OWNER', 'ADMIN'];

@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  private readonly access: ClinicalAccessService;

  constructor(private readonly prisma: PrismaService, @Optional() access?: ClinicalAccessService) {
    this.access = access ?? new ClinicalAccessService(prisma);
  }

  private assertClinical(user: AuthUser) {
    if (!CLINICAL_ROLES.includes(user.role)) throw new ForbiddenException('No tienes permiso para exportar información clínica');
  }

  private assertAdmin(user: AuthUser) {
    if (!ADMIN_ROLES.includes(user.role)) throw new ForbiddenException('Solo propietarios y administradores pueden exportar el workspace');
  }

  /**
   * "Step-up authentication": exportar es la acción de mayor impacto de toda la app (saca
   * datos clínicos o administrativos completos fuera del sistema), así que además del rol
   * exigimos volver a confirmar la contraseña justo antes. Esto también obliga a que el
   * endpoint sea POST (no GET), lo que lo protege con el guard de CSRF que ya usa el resto
   * de acciones que modifican o exponen algo sensible — un GET nunca pasa por ese guard.
   */
  private async assertPasswordConfirmed(user: AuthUser, password: string) {
    const account = await this.prisma.user.findUnique({ where: { id: user.sub }, select: { passwordHash: true } });
    const passwordOk = account ? await compare(password, account.passwordHash) : false;
    if (!passwordOk) throw new UnauthorizedException('Contraseña incorrecta');
  }

  private async audit(user: AuthUser, action: string, entityType: string, entityId?: string, metadata?: object) {
    await this.prisma.auditLog.create({
      data: { workspaceId: user.workspaceId, actorId: user.sub, action, entityType, entityId, metadata: metadata ?? {} },
    });
  }

  /**
   * Arts. 15/20 RGPD: la exportación debe entregar el contenido legible, nunca "enc:v1:…".
   * 1) descifrado tipado por modelo (common/crypto/clinical-crypto.ts, la misma lista que usan
   *    los servicios); 2) red de seguridad que descifra cualquier string cifrado que quede
   *    (campo nuevo no añadido al registro) y registra SOLO la ruta, nunca el valor.
   */
  private decryptForExport<T>(payload: T, exportType: string): T {
    const { value, leakedPaths } = decryptDeep(payload);
    if (leakedPaths.length) {
      this.logger.warn(`${exportType}: campos cifrados fuera del registro de clinical-crypto.ts: ${leakedPaths.slice(0, 20).join(', ')}`);
    }
    return value;
  }

  async exportPatient(user: AuthUser, patientId: string, password: string) {
    this.assertClinical(user);
    await this.assertPasswordConfirmed(user, password);
    // Mismo criterio que la API (ClinicalAccessService): quien trata al paciente exporta su
    // contenido clínico (sin notas internas ajenas); el autor de un proceso cerrado, solo lo suyo;
    // OWNER/ADMIN que no le tratan → 403 (la copia de custodia y la del art. 15 irán aparte).
    const { scope } = await this.access.assertCanRead(user.workspaceId, user, patientId, 'patient-export');
    const treating = scope.level === 'TREATING';
    const ws = user.workspaceId;
    const own = { workspaceId: ws, therapistId: user.sub };
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, workspaceId: ws, deletedAt: null },
      include: {
        clinicalHistory: treating,
        clinicalProcesses: { where: treating ? { workspaceId: ws } : own, orderBy: { startedAt: 'desc' } },
        sessions: { where: treating ? { workspaceId: ws } : own, orderBy: { startsAt: 'desc' } },
        therapyGoals: treating ? { orderBy: { createdAt: 'desc' } } : false,
        // Autor de un proceso cerrado: solo tareas enlazadas a sus sesiones.
        therapeuticTasks: treating ? { orderBy: { createdAt: 'desc' } } : { where: { session: own }, orderBy: { createdAt: 'desc' } },
        clinicalAssessments: treating ? { orderBy: { administeredAt: 'desc' } } : false,
        consentRecords: { where: treating ? { workspaceId: ws } : { workspaceId: ws, createdById: user.sub }, orderBy: { createdAt: 'desc' } },
        clinicalReports: { where: treating ? { workspaceId: ws } : { workspaceId: ws, createdById: user.sub }, orderBy: { createdAt: 'desc' } },
        patientDocuments: { where: treating ? { workspaceId: ws } : { workspaceId: ws, createdById: user.sub }, orderBy: { createdAt: 'desc' } },
        // Facturación: dato administrativo, solo para OWNER/ADMIN (THERAPIST no la ve en la API).
        ...(['OWNER', 'ADMIN'].includes(user.role) ? { invoices: { where: { workspaceId: ws }, include: { lines: true, payments: true }, orderBy: { createdAt: 'desc' as const } } } : {}),
        resourceShares: treating ? { where: { workspaceId: ws }, include: { resource: true }, orderBy: { sharedAt: 'desc' } } : false,
      },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    const record: any = decryptPatientRecord(patient);
    // Notas internas: solo las propias (proceso y resumen interno de sesión).
    record.clinicalProcesses = (record.clinicalProcesses ?? []).map((process: any) => {
      if (process.therapistId === user.sub) return process;
      const { internalNotes: _hidden, ...rest } = process;
      return rest;
    });
    record.sessions = (record.sessions ?? []).map((session: any) => {
      if (session.therapistId === user.sub) return session;
      const { internalSummary: _hidden, ...rest } = session;
      return rest;
    });
    // El motivo de consulta de la ficha no es atribuible a un autor: solo para quien trata.
    if (!treating) delete record.consultationReason;

    const generatedAt = new Date().toISOString();
    await this.audit(user, 'PATIENT_DATA_EXPORTED', 'Patient', patientId, { generatedAt, format: 'JSON', scope: scope.level });
    return {
      schemaVersion: '1.0',
      exportType: 'PATIENT_CLINICAL_RECORD',
      generatedAt,
      workspaceId: user.workspaceId,
      patient: this.decryptForExport(record, 'PATIENT_CLINICAL_RECORD'),
      notice: 'Exportación clínica confidencial. Debe almacenarse y transmitirse de forma segura.',
    };
  }

  async exportWorkspace(user: AuthUser, password: string) {
    this.assertAdmin(user);
    await this.assertPasswordConfirmed(user, password);

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
      // Hoy no incluye campos cifrados (solo datos administrativos), pero pasa por la misma red
      // de seguridad por si en el futuro se añade alguno.
      members: this.decryptForExport(workspace.members, 'WORKSPACE_ADMIN_EXPORT'),
      patients: this.decryptForExport(workspace.patients, 'WORKSPACE_ADMIN_EXPORT'),
      inventory: { sessions, invoices, resources, conversations },
      recentAuditLogs: this.decryptForExport(auditLogs, 'WORKSPACE_ADMIN_EXPORT'),
      notice: 'Esta exportación administrativa no sustituye a una copia de seguridad de PostgreSQL.',
    };
  }

  async getPilotReadiness(user: AuthUser) {
    this.assertAdmin(user);
    const [members, patients, futureSessions, portalAccounts, pendingConsents, overdueInvoices] = await Promise.all([
      this.prisma.workspaceMember.count({ where: { workspaceId: user.workspaceId } }),
      this.prisma.patient.count({ where: { workspaceId: user.workspaceId, deletedAt: null } }),
      this.prisma.session.count({ where: { workspaceId: user.workspaceId, startsAt: { gt: new Date() }, status: 'SCHEDULED' } }),
      this.prisma.patientPortalAccount.count({ where: { workspaceId: user.workspaceId, isActive: true } }),
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
