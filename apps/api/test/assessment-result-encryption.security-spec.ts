import { PatientAssessmentsService } from '../src/patients/patient-assessments.service';
import { PatientTasksService } from '../src/patients/patient-tasks.service';
import { PortalService } from '../src/portal/portal.service';
import { DECRYPTION_FAILED_PLACEHOLDER, decryptField, encryptField } from '../src/common/crypto/field-encryption';
import { decryptAssessment, encryptAssessmentResult } from '../src/common/crypto/clinical-crypto';

// Puntuación, gravedad y alerta de riesgo de las escalas se cifran juntas en `result`.
// Datos 100 % ficticios.
const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER' } as any;
const ENC = /^enc:v1:|^enc:v2:/;
const access: any = { assertPatientClinicalAccess: jest.fn(async () => ({ id: 'p1', status: 'ACTIVE' })) };

describe('ClinicalAssessment.result: totalScore, severity y riskFlag cifrados', () => {
  it('al crear, result va cifrado y las columnas en claro no se escriben; la auditoría no los copia', async () => {
    const tx: any = {
      clinicalAssessment: { create: jest.fn(async ({ data }: any) => ({ id: 'as-1', ...data })) },
      auditLog: { create: jest.fn(async () => ({})) },
    };
    const prisma: any = { ...tx, $transaction: jest.fn(async (cb: any) => cb(tx)) };
    // PHQ-9 con ítem 9 > 0 → riskFlag true. Total 12 → "Moderada".
    const result: any = await new PatientAssessmentsService(prisma, access).createClinicalAssessment('ws-1', owner, 'p1', { scaleCode: 'PHQ9', answers: [2, 2, 2, 1, 1, 1, 1, 1, 1] } as any);

    const data = tx.clinicalAssessment.create.mock.calls[0][0].data;
    expect(data.result).toMatch(ENC);
    expect(JSON.parse(decryptField(data.result)!)).toEqual({ totalScore: 12, severity: 'Moderada', riskFlag: true });
    expect(data).not.toHaveProperty('totalScore');
    expect(data).not.toHaveProperty('severity');
    expect(data).not.toHaveProperty('riskFlag');

    const metadata = tx.auditLog.create.mock.calls[0][0].data.metadata;
    expect(metadata).toEqual({ patientId: 'p1', scaleCode: 'PHQ9' });

    expect(result).toEqual(expect.objectContaining({ totalScore: 12, severity: 'Moderada', riskFlag: true }));
    expect(result).not.toHaveProperty('result');
  });

  it('decryptAssessment: result cifrado, fila legado (result NULL) y result ilegible', () => {
    const fromResult = decryptAssessment({ id: 'a', result: encryptAssessmentResult({ totalScore: 5, severity: 'Leve', riskFlag: false }), totalScore: null, severity: null, riskFlag: null });
    expect(fromResult).toEqual({ id: 'a', totalScore: 5, severity: 'Leve', riskFlag: false });

    const legacy = decryptAssessment({ id: 'b', result: null, totalScore: 17, severity: 'Moderadamente grave', riskFlag: true });
    expect(legacy).toEqual({ id: 'b', totalScore: 17, severity: 'Moderadamente grave', riskFlag: true });

    // Cifrado con una clave que no está configurada → no se inventa nada ni se expone el marcador.
    const saved = { k: process.env.FIELD_ENCRYPTION_KEYS, a: process.env.FIELD_ENCRYPTION_ACTIVE_KID };
    process.env.FIELD_ENCRYPTION_KEYS = 'retirada:clave-ficticia-retirada'; process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'retirada';
    const unreadable = encryptField(JSON.stringify({ totalScore: 3, severity: 'Mínima', riskFlag: false }));
    delete process.env.FIELD_ENCRYPTION_KEYS; delete process.env.FIELD_ENCRYPTION_ACTIVE_KID;
    try {
      const broken = decryptAssessment({ id: 'c', result: unreadable, totalScore: null, severity: null, riskFlag: null });
      expect(broken).toEqual({ id: 'c', totalScore: null, severity: null, riskFlag: false });
      expect(JSON.stringify(broken)).not.toContain(DECRYPTION_FAILED_PLACEHOLDER);
    } finally {
      if (saved.k === undefined) delete process.env.FIELD_ENCRYPTION_KEYS; else process.env.FIELD_ENCRYPTION_KEYS = saved.k;
      if (saved.a === undefined) delete process.env.FIELD_ENCRYPTION_ACTIVE_KID; else process.env.FIELD_ENCRYPTION_ACTIVE_KID = saved.a;
    }
  });

  it('timeline: muestra la puntuación y la gravedad descifradas', async () => {
    const empty = { findMany: jest.fn(async () => []) };
    const prisma: any = {
      patient: { findFirst: jest.fn(async () => ({ id: 'p1', createdAt: new Date() })) },
      clinicalHistory: { findUnique: jest.fn(async () => null) },
      therapyGoal: empty, therapeuticTask: empty, clinicalProcess: empty, session: empty, patientDocument: empty,
      consentRecord: empty, clinicalReport: empty, resourceShare: empty,
      clinicalAssessment: { findMany: jest.fn(async () => [{ id: 'as-1', scaleName: 'GAD-7', administeredAt: new Date(), result: encryptAssessmentResult({ totalScore: 9, severity: 'Leve', riskFlag: false }), totalScore: null, severity: null, riskFlag: null }]) },
    };
    const events: any[] = await new PatientTasksService(prisma, access).getTimeline('ws-1', owner, 'p1');
    const select = prisma.clinicalAssessment.findMany.mock.calls[0][0].select;
    expect(select.result).toBe(true);
    const ev = events.find((e) => e.type === 'ASSESSMENT');
    expect(ev.title).toBe('GAD-7: 9 puntos');
    expect(ev.description).toBe('Leve');
    expect(JSON.stringify(events)).not.toMatch(/enc:v[12]:/);
  });

  it('portal (exportación del paciente): puntuación y gravedad descifradas, sin la alerta interna riskFlag', async () => {
    const prisma: any = {
      patientPortalAccount: { findFirst: jest.fn(async () => ({ id: 'acc-1' })) },
      patient: { findFirst: jest.fn(async () => ({ id: 'p1', firstName: 'P', lastName: 'F' })) },
      session: { findMany: jest.fn(async () => []) },
      therapeuticTask: { findMany: jest.fn(async () => []) },
      clinicalAssessment: { findMany: jest.fn(async () => [{ scaleName: 'PHQ-9', administeredAt: new Date('2026-01-01'), result: encryptAssessmentResult({ totalScore: 12, severity: 'Moderada', riskFlag: true }), totalScore: null, severity: null, riskFlag: null }]) },
      consentRecord: { findMany: jest.fn(async () => []) },
      invoice: { findMany: jest.fn(async () => []) },
      auditLog: { create: jest.fn(async () => ({})) },
    };
    const out: any = await new PortalService(prisma, {} as any).exportData({ portalAccountId: 'acc-1', patientId: 'p1', workspaceId: 'ws-1', accessorType: 'PATIENT' });
    expect(out.assessments).toEqual([{ scaleName: 'PHQ-9', totalScore: 12, severity: 'Moderada', administeredAt: new Date('2026-01-01') }]);
    expect(JSON.stringify(out)).not.toMatch(/enc:v[12]:|riskFlag/);
  });
});
