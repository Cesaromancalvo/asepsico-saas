/**
 * Núcleo de db:purge-workspace (A3 del piloto demo; encargo de Argos del 23/11/2026, punto 4, y
 * Lex 24/11/2026, §7.2): borra un espacio ENTERO, no solo lo de ejemplo.
 *
 * - Borra todo lo que tenga `workspaceId = X` (pacientes demo y NO demo y todo lo que cuelga de ellos,
 *   procesos, sesiones, notas, mensajes, documentos, citas, facturas, portal, invitaciones, avisos,
 *   preferencias, disponibilidad...), siempre filtrado por ese workspaceId.
 * - Conserva, bloqueados, `TermsAcceptance` y `AuditLog` (evidencia, 3 años).
 * - Usuarios del espacio: se quedan solo con id y correo (nombre «Cuenta eliminada»), contraseña
 *   inservible, sin TOTP ni códigos de recuperación, tokenVersion + 1, sin sesiones y sin membresía.
 *   Si un usuario no tiene ni aceptaciones ni auditoría, se borra entero. Si alguno es miembro de
 *   OTRO espacio, no se toca nada.
 * - La fila Workspace se conserva (Restrict) con nombre «Espacio eliminado» y `purgedAt`.
 * - Evento WORKSPACE_PURGED en AuditLog solo con recuentos.
 * - Red de seguridad: al final, ninguna tabla con columna "workspaceId" puede tener filas de este
 *   espacio salvo AuditLog y TermsAcceptance. Si una tabla nueva se olvida aquí, la transacción
 *   falla y no se borra nada.
 *
 * Almacenamiento: AsePsico no guarda archivos. `PatientDocument.storageKey`, `Message.attachmentKey`
 * y `TherapeuticResource.storageKey` son referencias de texto que escribe el profesional; no hay
 * bucket ni cliente S3 en la API. Se borran con sus filas y en la auditoría solo queda su número.
 * Si algún día se suben archivos de verdad, este borrado debe ampliarse (lo vigila un test).
 */
import { randomBytes } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { DemoRefusal } from './demo-guards';

type Db = PrismaClient | Prisma.TransactionClient;

export const PURGED_WORKSPACE_NAME = 'Espacio eliminado';
export const PURGED_USER_FIRST_NAME = 'Cuenta eliminada';
export const PURGED_USER_LAST_NAME = '';
/** Tablas que se conservan con filas del espacio borrado (evidencia bloqueada). */
export const KEPT_TABLES = ['AuditLog', 'TermsAcceptance'] as const;

/**
 * Pasos de borrado en orden (los hijos con FK Restrict antes que sus padres). Cada paso cuenta y
 * borra con el MISMO filtro, siempre por workspaceId. Lo que no aparece cae en cascada con su padre:
 * ClinicalHistory, TherapyGoal, TherapeuticTask y ClinicalAssessment (Patient), InvoiceLine (Invoice),
 * Message (Conversation).
 */
const STEPS: { name: string; model: string }[] = [
  { name: 'notificationDeliveries', model: 'notificationDelivery' },
  { name: 'notifications', model: 'notification' },
  { name: 'notificationPreferences', model: 'notificationPreference' },
  { name: 'portalActivationTokens', model: 'portalActivationToken' },
  { name: 'portalSignupRequests', model: 'portalSignupRequest' },
  { name: 'portalIntakeLinks', model: 'portalIntakeLink' },
  { name: 'appointmentRequests', model: 'appointmentRequest' },
  { name: 'payments', model: 'payment' },
  { name: 'invoices', model: 'invoice' },
  { name: 'patientImportItems', model: 'patientImportItem' },
  { name: 'patientImportJobs', model: 'patientImportJob' },
  { name: 'sessions', model: 'session' },
  { name: 'clinicalProcessPrivateNotes', model: 'clinicalProcessPrivateNote' },
  { name: 'clinicalProcessOpenings', model: 'clinicalProcessOpening' },
  { name: 'exceptionalAccessJustifications', model: 'exceptionalAccessJustification' },
  { name: 'exceptionalAccessReasonMisses', model: 'exceptionalAccessReasonMiss' },
  { name: 'clinicalProcesses', model: 'clinicalProcess' },
  { name: 'resourceShares', model: 'resourceShare' },
  { name: 'therapeuticResources', model: 'therapeuticResource' },
  { name: 'taskTemplates', model: 'therapeuticTaskTemplate' },
  { name: 'conversations', model: 'conversation' },
  { name: 'patientDocuments', model: 'patientDocument' },
  { name: 'consentRecords', model: 'consentRecord' },
  { name: 'clinicalReports', model: 'clinicalReport' },
  { name: 'portalAccounts', model: 'patientPortalAccount' },
  { name: 'patients', model: 'patient' },
  { name: 'availabilityBlocks', model: 'availabilityBlock' },
  { name: 'availabilityWindows', model: 'availabilityWindow' },
  { name: 'therapistAvailabilities', model: 'therapistAvailability' },
  { name: 'workspaceInvites', model: 'workspaceInvite' },
  { name: 'registrationInvites', model: 'registrationInvite' },
  { name: 'refreshTokens', model: 'refreshToken' },
];

export interface WorkspacePurgeScope {
  workspaceId: string;
  counts: Record<string, number>;
  /** Referencias de almacenamiento (solo el número: pueden llevar nombres de archivo). */
  storageReferences: number;
  users: { id: string; keep: boolean }[];
  /** Usuarios del espacio que también son miembros de otro espacio (debe ser 0). */
  usersInOtherWorkspaces: number;
  /** Miembros que son administradores de la plataforma (debe ser 0: «AsePsico interno» nunca se borra así). */
  platformAdminMembers: number;
}

export interface WorkspacePurgeOptions {
  /** Correos de los administradores de la plataforma (ya normalizados; ver src/platform/platform-admin.config.ts). */
  platformAdminEmails?: ReadonlySet<string>;
  /** Repetir el borrado sobre un espacio ya purgado (p. ej. tras restaurar una copia). */
  again?: boolean;
  now?: Date;
}

async function dataRightsRequestsTableExists(db: Db): Promise<boolean> {
  const [{ exists }] = await db.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass('"DataRightsRequest"') IS NOT NULL AS "exists"`;
  return exists;
}

/** Qué se borraría. Solo lecturas, todas filtradas por workspaceId. */
export async function workspacePurgeScope(db: Db, workspaceId: string, platformAdminEmails: ReadonlySet<string> = new Set()): Promise<WorkspacePurgeScope> {
  const counts: Record<string, number> = {};
  for (const step of STEPS) counts[step.name] = await (db as any)[step.model].count({ where: { workspaceId } });
  counts.dataRightsRequests = (await dataRightsRequestsTableExists(db))
    ? Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "DataRightsRequest" WHERE "workspaceId" = ${workspaceId}`)[0].n)
    : 0;
  counts.members = await db.workspaceMember.count({ where: { workspaceId } });
  counts.messages = await db.message.count({ where: { conversation: { workspaceId } } });

  const [documents, attachments, resources] = await Promise.all([
    db.patientDocument.count({ where: { workspaceId, storageKey: { not: null } } }),
    db.message.count({ where: { attachmentKey: { not: null }, conversation: { workspaceId } } }),
    db.therapeuticResource.count({ where: { workspaceId, storageKey: { not: null } } }),
  ]);

  const members = await db.workspaceMember.findMany({ where: { workspaceId }, select: { userId: true, user: { select: { email: true } } } });
  const platformAdminMembers = members.filter((m) => platformAdminEmails.has(m.user.email.trim().toLowerCase())).length;
  const userIds = [...new Set(members.map((m) => m.userId))];
  const usersInOtherWorkspaces = userIds.length
    ? (await db.workspaceMember.findMany({ where: { userId: { in: userIds }, workspaceId: { not: workspaceId } }, select: { userId: true }, distinct: ['userId'] })).length
    : 0;
  const users: { id: string; keep: boolean }[] = [];
  for (const id of userIds) {
    // Se conserva (mínimo) si hay evidencia que lo nombra: aceptaciones o auditoría como actor.
    const [terms, audit] = await Promise.all([
      db.termsAcceptance.count({ where: { userId: id } }),
      db.auditLog.count({ where: { actorId: id } }),
    ]);
    users.push({ id, keep: terms + audit > 0 });
  }
  return { workspaceId, counts, storageReferences: documents + attachments + resources, users, usersInOtherWorkspaces, platformAdminMembers };
}

export function assertWorkspacePurgeable(scope: WorkspacePurgeScope) {
  if (scope.usersInOtherWorkspaces > 0) {
    throw new DemoRefusal(`${scope.usersInOtherWorkspaces} usuario(s) de este espacio son también miembros de otro espacio: no se borra nada (revisarlo a mano).`);
  }
  if (scope.platformAdminMembers > 0) {
    throw new DemoRefusal('Un miembro de este espacio es administrador de la plataforma: no se borra nada.');
  }
}

/** Tablas con columna "workspaceId" que aún tienen filas de este espacio (sin contar las conservadas). */
export async function remainingWorkspaceRows(db: Db, workspaceId: string): Promise<Record<string, number>> {
  const tables = await db.$queryRaw<{ table_name: string }[]>`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND c.column_name = 'workspaceId' AND t.table_type = 'BASE TABLE'`;
  const left: Record<string, number> = {};
  for (const { table_name } of tables) {
    if ((KEPT_TABLES as readonly string[]).includes(table_name)) continue;
    // El nombre sale de information_schema (no de la entrada) y se cita; el id va como parámetro.
    const quoted = `"${table_name.replace(/"/g, '""')}"`;
    const [{ n }] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${quoted} WHERE "workspaceId" = $1`, workspaceId);
    if (Number(n) > 0) left[table_name] = Number(n);
  }
  return left;
}

export class WorkspacePurgeIncomplete extends DemoRefusal {
  constructor(tables: string[]) {
    super(`Quedan filas del espacio en ${tables.join(', ')}: no se ha borrado nada (hay que añadir esas tablas a db:purge-workspace).`);
  }
}

/**
 * Borra el espacio. Debe ejecutarse dentro de UNA transacción (quien llama pasa el `tx`): si algo
 * falla, incluida la red de seguridad final, no queda nada a medias.
 */
export async function purgeWorkspace(tx: Prisma.TransactionClient, workspaceId: string, options: WorkspacePurgeOptions = {}) {
  const now = options.now ?? new Date();
  const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, purgedAt: true } });
  if (!workspace) throw new DemoRefusal('Espacio no encontrado.');
  if (workspace.purgedAt && !options.again) throw new DemoRefusal('Este espacio ya está borrado. Para volver a pasar el borrado (p. ej. tras restaurar una copia), usa --again.');
  const scope = await workspacePurgeScope(tx, workspaceId, options.platformAdminEmails);
  assertWorkspacePurgeable(scope);

  const deleted: Record<string, number> = {};
  if (await dataRightsRequestsTableExists(tx)) {
    deleted.dataRightsRequests = await tx.$executeRaw`DELETE FROM "DataRightsRequest" WHERE "workspaceId" = ${workspaceId}`;
  }
  deleted.messages = scope.counts.messages; // caen en cascada con las conversaciones
  for (const step of STEPS) {
    deleted[step.name] = (await (tx as any)[step.model].deleteMany({ where: { workspaceId } })).count;
  }
  deleted.members = (await tx.workspaceMember.deleteMany({ where: { workspaceId } })).count;

  let usersMinimized = 0;
  let usersDeleted = 0;
  for (const user of scope.users) {
    // Sus sesiones en cualquier espacio (solo pertenecía a este: comprobado arriba).
    await tx.refreshToken.deleteMany({ where: { userId: user.id } });
    if (user.keep) {
      await tx.user.update({
        where: { id: user.id },
        data: {
          firstName: PURGED_USER_FIRST_NAME,
          lastName: PURGED_USER_LAST_NAME,
          // Hash que no es de bcrypt: ninguna contraseña coincide.
          passwordHash: `!purged-${randomBytes(16).toString('hex')}`,
          totpEnabled: false,
          totpSecret: null,
          mfaRecoveryCodes: [],
          totpLastUsedStep: null,
          mfaFailedAttempts: 0,
          mfaLockedUntil: null,
          tokenVersion: { increment: 1 },
        },
      });
      usersMinimized++;
    } else {
      usersDeleted += (await tx.user.deleteMany({ where: { id: user.id, memberships: { none: {} } } })).count;
    }
  }

  await tx.workspace.update({ where: { id: workspaceId }, data: { name: PURGED_WORKSPACE_NAME, purgedAt: workspace.purgedAt ?? now } });

  const left = await remainingWorkspaceRows(tx, workspaceId);
  if (Object.keys(left).length) throw new WorkspacePurgeIncomplete(Object.keys(left));

  const summary = { ...deleted, storageReferences: scope.storageReferences, usersMinimized, usersDeleted, again: options.again ? 1 : 0 };
  await tx.auditLog.create({
    data: { workspaceId, actorId: null, action: 'WORKSPACE_PURGED', entityType: 'Workspace', entityId: workspaceId, metadata: { source: 'db:purge-workspace', ...summary } },
  });
  return summary;
}
