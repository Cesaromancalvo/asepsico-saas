import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { hash } from 'bcryptjs';
import { encryptField } from '../src/common/crypto/field-encryption';
import { ExportsService } from '../src/exports/exports.service';
import { PortalService } from '../src/portal/portal.service';
import { MemberRemovalService } from '../src/workspace-members/member-removal.service';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Notas internas de un profesional anterior (ClinicalProcessPrivateNote, historia B). Condición de
 * Argos: salen descifradas, con autor y proceso, SOLO en la exportación completa del workspace
 * (OWNER/ADMIN con contraseña). Nunca en la exportación del paciente (art. 18.3 Ley 41/2002), ni
 * en la de un THERAPIST, ni en el portal; ningún endpoint devuelve el campo `notes`.
 * Datos 100 % ficticios.
 */

const WS = 'ws-1';
const WS2 = 'ws-2';
const PASSWORD = 'contrasena-ficticia-123';
const OLD_NOTE = 'Nota interna ficticia del profesional anterior';
const actor = (sub: string, role: string, workspaceId = WS) => ({ sub, workspaceId, role, email: `${sub}@example.test` }) as any;

async function setup() {
  const passwordHash = await hash(PASSWORD, 4);
  const prisma = fakeClinicalDb({
    workspace: [{ id: WS, name: 'Consulta ficticia', createdAt: new Date(), updatedAt: new Date() }, { id: WS2, name: 'Otra consulta ficticia' }],
    user: ['owner-1', 'ther-1', 'ther-2', 'owner-x'].map((id) => ({ id, email: `${id}@example.test`, passwordHash, firstName: id === 'ther-1' ? 'Profesional' : 'Nombre', lastName: id === 'ther-1' ? 'Anterior' : 'Ficticio' })),
    workspaceMember: [
      { id: 'm-owner', workspaceId: WS, userId: 'owner-1', role: 'OWNER', isClinician: false, createdAt: new Date('2026-01-01') },
      { id: 'm-ther1', workspaceId: WS, userId: 'ther-1', role: 'THERAPIST', isClinician: true, createdAt: new Date('2026-01-02') },
      { id: 'm-ther2', workspaceId: WS, userId: 'ther-2', role: 'THERAPIST', isClinician: true, createdAt: new Date('2026-01-03') },
      { id: 'm-ws2', workspaceId: WS2, userId: 'owner-x', role: 'OWNER', isClinician: false, createdAt: new Date('2026-01-04') },
    ],
    patient: [{ id: 'pat-1', workspaceId: WS, firstName: 'Paciente', lastName: 'Uno', status: 'ACTIVE', deletedAt: null }],
    clinicalProcess: [{ id: 'p-active', workspaceId: WS, patientId: 'pat-1', therapistId: 'ther-1', status: 'ACTIVE', title: 'Proceso ficticio', internalNotes: encryptField(OLD_NOTE), startedAt: new Date() }],
    patientPortalAccount: [{ id: 'acc-1', workspaceId: WS, patientId: 'pat-1', isActive: true }],
    therapeuticResource: [], invoice: [], conversation: [], consentRecord: [],
  } as any);
  await new MemberRemovalService(prisma).remove(WS, actor('owner-1', 'OWNER'), 'ther-1', { reassignToUserId: 'ther-2' });
  // El doble no resuelve relaciones con select: se resuelven aquí autor y proceso desde el almacén.
  const original = prisma.clinicalProcessPrivateNote.findMany;
  prisma.clinicalProcessPrivateNote.findMany = jest.fn(async (args: any) => (await original(args)).map((note: any) => ({
    ...note,
    author: prisma.__store.user.find((u: any) => u.id === note.authorId),
    process: prisma.__store.clinicalProcess.find((p: any) => p.id === note.processId),
  })));
  return prisma;
}

describe('Exportación de las notas internas de un profesional anterior', () => {
  it('la exportación completa del workspace (OWNER) las incluye descifradas, con autor y proceso, acotadas al workspace y auditadas', async () => {
    const prisma = await setup();
    const out: any = await new ExportsService(prisma).exportWorkspace(actor('owner-1', 'OWNER'), PASSWORD);
    expect(prisma.clinicalProcessPrivateNote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS } }));
    expect(out.clinicalProcessInternalNotes.previousAuthors).toEqual([expect.objectContaining({
      processId: 'p-active', patientId: 'pat-1', processTitle: 'Proceso ficticio', authorId: 'ther-1', authorName: 'Profesional Anterior',
      internalNotes: OLD_NOTE, reason: 'REASSIGNED',
    })]);
    expect(JSON.stringify(out)).not.toMatch(/enc:v[12]:/);
    expect(prisma.__store.auditLog).toContainEqual(expect.objectContaining({ action: 'WORKSPACE_DATA_EXPORTED', metadata: expect.objectContaining({ previousAuthorNotes: 1 }) }));
  });

  it('el OWNER de otro workspace no recibe nada de este', async () => {
    const prisma = await setup();
    const out: any = await new ExportsService(prisma).exportWorkspace(actor('owner-x', 'OWNER', WS2), PASSWORD);
    expect(out.clinicalProcessInternalNotes.previousAuthors).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(OLD_NOTE);
  });

  it('la exportación del paciente hecha por el THERAPIST destino NO las incluye', async () => {
    const prisma = await setup();
    const out: any = await new ExportsService(prisma).exportPatient(actor('ther-2', 'THERAPIST'), 'pat-1', PASSWORD);
    expect(out.exportType).toBe('PATIENT_CLINICAL_RECORD');
    expect(JSON.stringify(out)).not.toContain(OLD_NOTE);
    expect(prisma.clinicalProcessPrivateNote.findMany).not.toHaveBeenCalled();
  });

  it('la exportación del portal (paciente o tutor) NO las incluye', async () => {
    const prisma = await setup();
    const out = await new PortalService(prisma, {} as any).exportData({ portalAccountId: 'acc-1', patientId: 'pat-1', workspaceId: WS, accessorType: 'PATIENT' });
    expect(JSON.stringify(out)).not.toContain(OLD_NOTE);
    expect(prisma.clinicalProcessPrivateNote.findMany).not.toHaveBeenCalled();
  });

  it('ningún código de la API lee el campo notes de ClinicalProcessPrivateNote salvo la exportación del workspace', () => {
    const root = join(__dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir).forEach((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    });
    walk(root);
    const users = files.filter((f) => /clinicalProcessPrivateNote\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|aggregate|groupBy)/.test(readFileSync(f, 'utf8')));
    expect(users.map((f) => f.slice(root.length + 1))).toEqual(['exports/exports.service.ts']);
    // Y la exportación solo lo hace dentro de exportWorkspace.
    const source = readFileSync(join(root, 'exports', 'exports.service.ts'), 'utf8');
    const start = source.indexOf('async exportWorkspace(');
    const end = source.indexOf('\n  async ', start + 1);
    const at = source.indexOf('clinicalProcessPrivateNote.findMany');
    expect(at).toBeGreaterThan(start);
    expect(end === -1 || at < end).toBe(true);
  });
});
