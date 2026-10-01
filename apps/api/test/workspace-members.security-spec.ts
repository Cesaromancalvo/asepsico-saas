import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { WorkspaceMembersService } from '../src/workspace-members/workspace-members.service';
import { PatientsService } from '../src/patients/patients.service';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Atributo clínico del miembro (WorkspaceMember.isClinician). Solo el OWNER lo cambia, queda
 * auditado en la misma transacción, un ASSISTANT nunca puede ser clínico y marcar a alguien como
 * clínico NO le da acceso a ningún paciente por sí solo. Datos 100 % ficticios.
 */

const WS = 'ws-1';
const actor = (sub: string, role: string, workspaceId = WS) => ({ sub, workspaceId, role, email: `${sub}@example.com` }) as any;

function db() {
  return fakeClinicalDb({
    workspaceMember: [
      { id: 'm-owner', workspaceId: WS, userId: 'owner-1', role: 'OWNER', isClinician: false, createdAt: new Date('2026-01-01') },
      { id: 'm-admin', workspaceId: WS, userId: 'admin-1', role: 'ADMIN', isClinician: false, createdAt: new Date('2026-01-02') },
      { id: 'm-ther', workspaceId: WS, userId: 'ther-1', role: 'THERAPIST', isClinician: false, createdAt: new Date('2026-01-03') },
      { id: 'm-asst', workspaceId: WS, userId: 'asst-1', role: 'ASSISTANT', isClinician: false, createdAt: new Date('2026-01-04') },
      { id: 'm-ws2', workspaceId: 'ws-2', userId: 'ther-ws2', role: 'THERAPIST', isClinician: false, createdAt: new Date('2026-01-05') },
    ],
    patient: [{ id: 'pat-1', workspaceId: WS, firstName: 'Paciente', lastName: 'Ficticio', status: 'ACTIVE', deletedAt: null }],
    clinicalHistory: [{ id: 'h-1', patientId: 'pat-1', currentProblem: 'Texto ficticio' }],
  });
}

describe('PATCH /workspace-members/:userId/clinician', () => {
  it('el OWNER marca a un miembro como clínico: escritura acotada y auditada en la transacción', async () => {
    const prisma = db();
    const result = await new WorkspaceMembersService(prisma).setClinician(WS, actor('owner-1', 'OWNER'), 'ther-1', { isClinician: true });
    expect(result).toMatchObject({ userId: 'ther-1', role: 'THERAPIST', isClinician: true });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.workspaceMember.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'm-ther', workspaceId: WS, role: { not: 'ASSISTANT' } }),
    }));
    expect(prisma.__store.auditLog).toEqual([expect.objectContaining({
      workspaceId: WS, actorId: 'owner-1', action: 'MEMBER_CLINICIAN_CHANGED', entityType: 'WorkspaceMember', entityId: 'm-ther',
      metadata: { userId: 'ther-1', role: 'THERAPIST', from: false, to: true },
    })]);
  });

  it('el OWNER puede marcarse a sí mismo como clínico', async () => {
    const prisma = db();
    await new WorkspaceMembersService(prisma).setClinician(WS, actor('owner-1', 'OWNER'), 'owner-1', { isClinician: true });
    expect(prisma.__store.workspaceMember.find((m: any) => m.userId === 'owner-1').isClinician).toBe(true);
  });

  it('sin cambio real no escribe ni audita', async () => {
    const prisma = db();
    await new WorkspaceMembersService(prisma).setClinician(WS, actor('owner-1', 'OWNER'), 'ther-1', { isClinician: false });
    expect(prisma.workspaceMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it.each([['ADMIN', 'admin-1'], ['THERAPIST', 'ther-1'], ['ASSISTANT', 'asst-1']])('%s → 403 sin escribir', async (role, sub) => {
    const prisma = db();
    await expect(new WorkspaceMembersService(prisma).setClinician(WS, actor(sub, role), 'ther-1', { isClinician: true })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it('token con rol OWNER pero la BD dice ADMIN → 403 (decide la BD)', async () => {
    const prisma = db();
    await expect(new WorkspaceMembersService(prisma).setClinician(WS, actor('admin-1', 'OWNER'), 'ther-1', { isClinician: true })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un ASSISTANT no puede ser clínico → 400 sin escribir', async () => {
    const prisma = db();
    await expect(new WorkspaceMembersService(prisma).setClinician(WS, actor('owner-1', 'OWNER'), 'asst-1', { isClinician: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.workspaceMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.__store.auditLog).toEqual([]);
  });

  it('miembro de otro workspace → 404 sin escribir', async () => {
    const prisma = db();
    await expect(new WorkspaceMembersService(prisma).setClinician(WS, actor('owner-1', 'OWNER'), 'ther-ws2', { isClinician: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.workspaceMember.updateMany).not.toHaveBeenCalled();
  });

  it('marcar como clínico NO da acceso a ningún paciente: sigue haciendo falta un proceso activo', async () => {
    const prisma = db();
    await new WorkspaceMembersService(prisma).setClinician(WS, actor('owner-1', 'OWNER'), 'ther-1', { isClinician: true });
    await expect(new PatientsService(prisma).getClinicalHistory(WS, actor('ther-1', 'THERAPIST'), 'pat-1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('GET /workspace-members', () => {
  it.each([['OWNER', 'owner-1'], ['ADMIN', 'admin-1']])('%s lista el equipo del workspace con isClinician', async (role, sub) => {
    const rows = await new WorkspaceMembersService(db()).list(WS, actor(sub, role));
    expect(rows.map((r) => r.userId)).toEqual(['owner-1', 'admin-1', 'ther-1', 'asst-1']);
    expect(rows.every((r) => typeof r.isClinician === 'boolean')).toBe(true);
  });

  it.each([['THERAPIST', 'ther-1'], ['ASSISTANT', 'asst-1']])('%s → 403', async (role, sub) => {
    await expect(new WorkspaceMembersService(db()).list(WS, actor(sub, role))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Migración de isClinician', () => {
  const dir = join(__dirname, '..', 'prisma', 'migrations');
  const name = readdirSync(dir).find((d) => d.endsWith('_add_workspace_member_is_clinician'));
  const sql = name ? readFileSync(join(dir, name, 'migration.sql'), 'utf8') : '';

  it('existe, añade la columna con false por defecto y la garantía de que un ASSISTANT nunca es clínico', () => {
    expect(name).toBeDefined();
    expect(sql).toContain('ADD COLUMN     "isClinician" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toMatch(/CHECK \(NOT \("role" = 'ASSISTANT' AND "isClinician"\)\)/);
  });

  it('da valor inicial: THERAPIST y OWNER clínicos; ADMIN solo si ya atiende procesos; ASSISTANT nunca', () => {
    expect(sql).toMatch(/SET "isClinician" = true WHERE "role" IN \('THERAPIST', 'OWNER'\)/);
    expect(sql).toMatch(/wm\."role" = 'ADMIN'[\s\S]*"ClinicalProcess"[\s\S]*"therapistId" = wm\."userId"/);
    expect(sql).not.toMatch(/SET "isClinician" = true[^;]*'ASSISTANT'/);
  });
});
