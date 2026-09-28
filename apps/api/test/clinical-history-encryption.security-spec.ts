import { PatientCareService } from '../src/patients/patient-care.service';
import { CLINICAL_HISTORY_ENCRYPTED_FIELDS } from '../src/common/crypto/clinical-crypto';
import { decryptField } from '../src/common/crypto/field-encryption';

// Datos 100 % ficticios.
const owner = { sub: 'owner-1', workspaceId: 'ws-1', role: 'OWNER' } as any;
const ENC = /^enc:v1:|^enc:v2:/;
const FIELDS = [
  'reasonForConsultation', 'currentProblem', 'personalHistory', 'familyHistory', 'medicalHistory',
  'currentMedication', 'primaryDiagnosis', 'riskFactors', 'protectiveFactors', 'clinicalObservations',
];
const dto = Object.fromEntries(FIELDS.map((f) => [f, `Texto ficticio de ${f}`]));

function setup(existingCount: number) {
  let stored: any = null;
  const tx: any = {
    clinicalHistory: {
      updateMany: jest.fn(async ({ data }: any) => { if (existingCount) stored = { id: 'hist-1', patientId: 'patient-1', ...data }; return { count: existingCount }; }),
      create: jest.fn(async ({ data }: any) => { stored = { id: 'hist-1', ...data }; return stored; }),
      findFirst: jest.fn(async () => stored),
      findUnique: jest.fn(async () => stored),
    },
    patient: { findFirst: jest.fn(async () => ({ id: 'patient-1' })) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const prisma: any = { ...tx, $transaction: jest.fn(async (cb: any) => cb(tx)) };
  const access: any = { assertPatientClinicalAccess: jest.fn(async () => ({ id: 'patient-1', status: 'ACTIVE' })) };
  return { prisma, tx, service: new PatientCareService(prisma, access), getStored: () => stored };
}

describe('ClinicalHistory: los 10 campos narrativos se cifran en reposo', () => {
  it('la constante CLINICAL_HISTORY_ENCRYPTED_FIELDS lista exactamente los 10 campos', () => {
    expect([...CLINICAL_HISTORY_ENCRYPTED_FIELDS].sort()).toEqual([...FIELDS].sort());
  });

  it('updateMany recibe los 10 campos cifrados (historia existente)', async () => {
    const { tx, service } = setup(1);
    await service.updateClinicalHistory('ws-1', owner, 'patient-1', dto as any);
    const data = tx.clinicalHistory.updateMany.mock.calls[0][0].data;
    for (const f of FIELDS) {
      expect(data[f]).toMatch(ENC);
      expect(decryptField(data[f])).toBe(dto[f]);
    }
    expect(tx.clinicalHistory.create).not.toHaveBeenCalled();
  });

  it('create recibe los 10 campos cifrados (historia nueva)', async () => {
    const { tx, service } = setup(0);
    await service.updateClinicalHistory('ws-1', owner, 'patient-1', dto as any);
    const data = tx.clinicalHistory.create.mock.calls[0][0].data;
    for (const f of FIELDS) expect(data[f]).toMatch(ENC);
  });

  it('update devuelve en claro y la auditoría solo lleva nombres de campo', async () => {
    const { tx, service } = setup(1);
    const saved: any = await service.updateClinicalHistory('ws-1', owner, 'patient-1', dto as any);
    for (const f of FIELDS) expect(saved[f]).toBe(dto[f]);
    const audit = JSON.stringify(tx.auditLog.create.mock.calls[0][0]);
    for (const f of FIELDS) expect(audit).not.toContain(dto[f]);
    expect(tx.auditLog.create.mock.calls[0][0].data.metadata.updatedFields).toEqual(FIELDS);
  });

  it('get devuelve los campos en claro, y los datos antiguos en claro siguen legibles', async () => {
    const { prisma, service, getStored } = setup(1);
    await service.updateClinicalHistory('ws-1', owner, 'patient-1', dto as any);
    expect(getStored().currentProblem).toMatch(ENC);
    const history: any = await service.getClinicalHistory('ws-1', owner, 'patient-1');
    for (const f of FIELDS) expect(history[f]).toBe(dto[f]);

    prisma.clinicalHistory.findUnique.mockResolvedValueOnce({ id: 'hist-legacy', patientId: 'patient-1', currentProblem: 'Dato antiguo en claro ficticio' });
    expect(((await service.getClinicalHistory('ws-1', owner, 'patient-1')) as any).currentProblem).toBe('Dato antiguo en claro ficticio');
  });
});
