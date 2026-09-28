import { hashSync } from 'bcryptjs';
import { ExportsService } from '../src/exports/exports.service';
import { encryptField } from '../src/common/crypto/field-encryption';
import { ENCRYPTED_TEXT_FIELDS, encryptAssessmentResult, encryptJsonField } from '../src/common/crypto/clinical-crypto';

// Datos 100 % ficticios. Contraseña solo de test (step-up de la exportación).
const PASSWORD = 'contrasena-ficticia-de-test';
const owner: any = { sub: 'u-owner', workspaceId: 'w1', role: 'OWNER' };

/** Fila con TODOS los campos cifrados del modelo, como estarían en la BD. */
function encryptedRow(model: keyof typeof ENCRYPTED_TEXT_FIELDS, extra: Record<string, any> = {}) {
  const row: Record<string, any> = { id: `${model}-1`, ...extra };
  for (const f of ENCRYPTED_TEXT_FIELDS[model]) row[f] = encryptField(`${model}.${f} ficticio`);
  return row;
}

/** Recorrido recursivo: rutas de cualquier string que empiece por "enc:". */
function encryptedPaths(value: any, path = '$'): string[] {
  if (typeof value === 'string') return value.startsWith('enc:') ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => encryptedPaths(v, `${path}[${i}]`));
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).flatMap(([k, v]) => encryptedPaths(v, `${path}.${k}`));
  return [];
}

function mockPrisma(patient: any) {
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ passwordHash: hashSync(PASSWORD, 4) }) },
    patient: { findFirst: jest.fn().mockResolvedValueOnce({ id: 'p1' }).mockResolvedValueOnce(patient) },
    auditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    workspace: { findUnique: jest.fn() },
    session: { count: jest.fn() }, invoice: { count: jest.fn() }, therapeuticResource: { count: jest.fn() }, conversation: { count: jest.fn() },
  } as any;
}

describe('Exportación clínica (arts. 15/20 RGPD): nunca sale texto cifrado', () => {
  it('descifra todos los campos cifrados de la ficha y de sus relaciones', async () => {
    const patient = {
      ...encryptedRow('patient', { firstName: 'Paciente', lastName: 'Ficticio' }),
      clinicalHistory: encryptedRow('clinicalHistory'),
      clinicalProcesses: [encryptedRow('clinicalProcess')],
      sessions: [encryptedRow('session')],
      therapyGoals: [encryptedRow('therapyGoal')],
      therapeuticTasks: [encryptedRow('therapeuticTask', { title: 'Tarea' })],
      clinicalAssessments: [{ ...encryptedRow('clinicalAssessment', { answers: encryptJsonField([1, 2, 3]) }), result: encryptAssessmentResult({ totalScore: 6, severity: 'Leve', riskFlag: false }), totalScore: null, severity: null, riskFlag: null }],
      consentRecords: [encryptedRow('consentRecord')],
      clinicalReports: [encryptedRow('clinicalReport')],
      patientDocuments: [encryptedRow('patientDocument')],
      invoices: [], resourceShares: [],
    };
    expect(encryptedPaths(patient).length).toBeGreaterThan(20); // el fixture sí está cifrado

    const result: any = await new ExportsService(mockPrisma(patient)).exportPatient(owner, 'p1', PASSWORD);

    expect(encryptedPaths(result)).toEqual([]);
    expect(result.patient.consultationReason).toBe('patient.consultationReason ficticio');
    expect(result.patient.clinicalHistory.riskFactors).toBe('clinicalHistory.riskFactors ficticio');
    expect(result.patient.therapyGoals[0].title).toBe('therapyGoal.title ficticio');
    expect(result.patient.sessions[0].notes).toBe('session.notes ficticio');
    expect(result.patient.consentRecords[0].notes).toBe('consentRecord.notes ficticio');
    expect(result.patient.clinicalAssessments[0].answers).toEqual([1, 2, 3]);
    expect(result.patient.clinicalAssessments[0]).toEqual(expect.objectContaining({ totalScore: 6, severity: 'Leve', riskFlag: false }));
    expect(result.patient.clinicalAssessments[0]).not.toHaveProperty('result');
  });

  it('red de seguridad: un campo cifrado fuera del registro también sale descifrado', async () => {
    const patient = {
      id: 'p1', clinicalHistory: null, clinicalProcesses: [], sessions: [], therapyGoals: [], therapeuticTasks: [],
      clinicalAssessments: [], consentRecords: [], clinicalReports: [], patientDocuments: [], resourceShares: [],
      invoices: [{ id: 'inv-1', lines: [{ description: encryptField('Concepto ficticio') }], payments: [] }],
    };
    const result: any = await new ExportsService(mockPrisma(patient)).exportPatient(owner, 'p1', PASSWORD);
    expect(encryptedPaths(result)).toEqual([]);
    expect(result.patient.invoices[0].lines[0].description).toBe('Concepto ficticio');
  });
});
