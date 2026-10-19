import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { hash } from 'bcryptjs';
import { encryptField } from '../src/common/crypto/field-encryption';
import { ExportsService } from '../src/exports/exports.service';
import { PortalService } from '../src/portal/portal.service';
import { MemberRemovalService } from '../src/workspace-members/member-removal.service';
import { fakeClinicalDb } from './support/fake-clinical-db';

/**
 * Notas internas de un profesional anterior (ClinicalProcessPrivateNote, historia B). Decisión de
 * Argos: hoy no tienen NINGUNA vía de lectura. Ninguna exportación (workspace, paciente, THERAPIST,
 * portal) incluye su contenido ni su texto cifrado; la del workspace solo da un recuento agregado.
 * Su devolución depende de la futura exportación clínica completa H1. Datos 100 % ficticios.
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
    user: ['owner-1', 'ther-1', 'ther-2', 'owner-x'].map((id) => ({ id, email: `${id}@example.test`, passwordHash, firstName: 'Nombre', lastName: 'Ficticio' })),
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
  const cipher = prisma.__store.clinicalProcessPrivateNote[0].notes as string;
  return { prisma, cipher };
}

/** Ni el texto en claro ni el cifrado de la nota archivada. */
function expectNoNote(value: unknown, cipher: string) {
  const json = JSON.stringify(value);
  expect(json).not.toContain(OLD_NOTE);
  expect(json).not.toContain(cipher);
}

describe('Las notas internas archivadas no salen en ninguna exportación', () => {
  it('exportación del workspace (OWNER): solo el recuento agregado, sin contenido, ids de paciente ni títulos', async () => {
    const { prisma, cipher } = await setup();
    const out: any = await new ExportsService(prisma).exportWorkspace(actor('owner-1', 'OWNER'), PASSWORD);
    expect(out.inventory.archivedPrivateNotes).toBe(1);
    expect(out).not.toHaveProperty('clinicalProcessInternalNotes');
    expectNoNote(out, cipher);
    expect(prisma.clinicalProcessPrivateNote.findMany).not.toHaveBeenCalled();
    expect(prisma.clinicalProcessPrivateNote.count).toHaveBeenCalledWith({ where: { workspaceId: WS } });
  });

  it('exportación del workspace desde otro espacio: recuento 0 y nada de este', async () => {
    const { prisma, cipher } = await setup();
    const out: any = await new ExportsService(prisma).exportWorkspace(actor('owner-x', 'OWNER', WS2), PASSWORD);
    expect(out.inventory.archivedPrivateNotes).toBe(0);
    expectNoNote(out, cipher);
  });

  it('exportación del paciente hecha por el THERAPIST destino: nada', async () => {
    const { prisma, cipher } = await setup();
    const out: any = await new ExportsService(prisma).exportPatient(actor('ther-2', 'THERAPIST'), 'pat-1', PASSWORD);
    expect(out.exportType).toBe('PATIENT_CLINICAL_RECORD');
    expectNoNote(out, cipher);
  });

  it('exportación del portal (paciente o tutor): nada', async () => {
    const { prisma, cipher } = await setup();
    const out = await new PortalService(prisma, {} as any).exportData({ portalAccountId: 'acc-1', patientId: 'pat-1', workspaceId: WS, accessorType: 'PATIENT' });
    expectNoNote(out, cipher);
  });

  it('ningún código de la API lee filas de ClinicalProcessPrivateNote: solo recuentos y la escritura del archivo', () => {
    const root = join(__dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir).forEach((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    });
    walk(root);
    const readers = files.filter((f) => /clinicalProcessPrivateNote\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|aggregate|groupBy)/.test(readFileSync(f, 'utf8')));
    expect(readers).toEqual([]);
    // Las únicas escrituras: la creación en la reasignación, que solo devuelve el id.
    const removal = readFileSync(join(root, 'workspace-members', 'member-removal.service.ts'), 'utf8');
    expect(removal).toMatch(/clinicalProcessPrivateNote\.create\(\{[\s\S]*?select: \{ id: true \}/);
  });
});
