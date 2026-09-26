import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { hashSync } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { ExportsService } from '../src/exports/exports.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { PatientCareService } from '../src/patients/patient-care.service';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { DECRYPTION_FAILED_PLACEHOLDER, encryptField } from '../src/common/crypto/field-encryption';
import { encryptModelData } from '../src/common/crypto/clinical-crypto';

// Correcciones del veto de Argos sobre fix/clinical-field-encryption. Datos 100 % ficticios.
const PASSWORD = 'contrasena-ficticia-de-test';
const therapist: any = { sub: 'ther-a', workspaceId: 'w1', role: 'THERAPIST' };
const owner: any = { sub: 'owner-1', workspaceId: 'w1', role: 'OWNER' };

/** Aplica el `where` plano de un include (igualdad de campos) sobre un array de filas. */
const applyWhere = (rows: any[], spec: any) => (spec?.where ? rows.filter((r) => Object.entries(spec.where).every(([k, v]) => r[k] === v)) : rows);

describe('B1: la exportación de un THERAPIST solo incluye SUS procesos y sesiones', () => {
  const fixture = {
    id: 'p1', workspaceId: 'w1', firstName: 'Paciente', lastName: 'Compartido', clinicalHistory: null,
    clinicalProcesses: [
      { id: 'proc-a', workspaceId: 'w1', therapistId: 'ther-a', internalNotes: encryptField('Nota interna ficticia de A') },
      { id: 'proc-b', workspaceId: 'w1', therapistId: 'ther-b', internalNotes: encryptField('Nota interna ficticia de B') },
    ],
    sessions: [
      { id: 'ses-a', workspaceId: 'w1', therapistId: 'ther-a', notes: encryptField('Nota de sesión ficticia de A'), internalSummary: null },
      { id: 'ses-b', workspaceId: 'w1', therapistId: 'ther-b', notes: encryptField('Nota de sesión ficticia de B'), internalSummary: encryptField('Resumen ficticio de B') },
    ],
    invoices: [{ id: 'inv-1', workspaceId: 'w1', lines: [], payments: [] }],
    therapyGoals: [], therapeuticTasks: [], clinicalAssessments: [], consentRecords: [], clinicalReports: [], patientDocuments: [], resourceShares: [],
  };
  function prisma() {
    return {
      user: { findUnique: jest.fn().mockResolvedValue({ passwordHash: hashSync(PASSWORD, 4) }) },
      patient: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({ id: 'p1' })
          .mockImplementationOnce(async ({ include }: any) => {
            const out: any = { ...fixture };
            for (const key of ['clinicalProcesses', 'sessions', 'invoices']) {
              if (include[key]) out[key] = applyWhere((fixture as any)[key], include[key]);
              else delete out[key];
            }
            return out;
          }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    } as any;
  }

  it('THERAPIST exporta un paciente compartido y no aparece nada del otro terapeuta', async () => {
    const p = prisma();
    const result: any = await new ExportsService(p).exportPatient(therapist, 'p1', PASSWORD);
    const include = p.patient.findFirst.mock.calls[1][0].include;
    expect(include.clinicalProcesses.where).toEqual({ workspaceId: 'w1', therapistId: 'ther-a' });
    expect(include.sessions.where).toEqual({ workspaceId: 'w1', therapistId: 'ther-a' });
    expect(include.invoices).toBeUndefined(); // la facturación no es accesible para THERAPIST
    const json = JSON.stringify(result);
    expect(json).toContain('Nota interna ficticia de A');
    expect(json).not.toMatch(/de B|proc-b|ses-b/);
    expect(json).not.toMatch(/enc:v[12]:/);
  });

  it('OWNER sigue exportando todos los procesos y sesiones del paciente', async () => {
    const p = prisma();
    const result: any = await new ExportsService(p).exportPatient(owner, 'p1', PASSWORD);
    expect(result.patient.clinicalProcesses).toHaveLength(2);
    expect(result.patient.sessions).toHaveLength(2);
    expect(result.patient.invoices).toHaveLength(1);
  });
});

describe('B2: el marcador de "no se pudo descifrar" nunca se persiste encima del original', () => {
  it('encryptField(PLACEHOLDER) lanza 422, también vía encryptModelData', () => {
    expect(() => encryptField(DECRYPTION_FAILED_PLACEHOLDER)).toThrow(UnprocessableEntityException);
    expect(() => encryptField(`  ${DECRYPTION_FAILED_PLACEHOLDER} `)).toThrow(UnprocessableEntityException);
    expect(() => encryptModelData('clinicalHistory', { currentProblem: DECRYPTION_FAILED_PLACEHOLDER })).toThrow(UnprocessableEntityException);
  });

  it('reprogramar una sesión con nota indescifrable deja notes/internalSummary intactos', async () => {
    // Valor v2 con un kid que no está configurado: la lectura devuelve el marcador.
    const saved = { FIELD_ENCRYPTION_KEYS: process.env.FIELD_ENCRYPTION_KEYS, FIELD_ENCRYPTION_ACTIVE_KID: process.env.FIELD_ENCRYPTION_ACTIVE_KID };
    process.env.FIELD_ENCRYPTION_KEYS = `retirada:${randomBytes(32).toString('base64')}`;
    process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'retirada';
    const unreadable = encryptField('Nota ficticia cifrada con una clave retirada')!;
    delete process.env.FIELD_ENCRYPTION_KEYS; delete process.env.FIELD_ENCRYPTION_ACTIVE_KID;
    try {
      const row = { id: 's1', workspaceId: 'w1', therapistId: 'owner-1', status: 'SCHEDULED', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000), notes: unreadable, internalSummary: unreadable };
      const prisma: any = {
        session: { findFirst: jest.fn(async (args: any) => (args?.where?.id === 's1' ? row : null)), updateMany: jest.fn(async () => ({ count: 1 })), update: jest.fn() },
        auditLog: { create: jest.fn(async () => ({})) },
      };
      const service = new SessionsService(prisma);
      const before: any = await service.get('w1', owner, 's1');
      expect(before.notes).toBe(DECRYPTION_FAILED_PLACEHOLDER);

      await service.reschedule('w1', owner, 's1', { startsAt: new Date(Date.now() + 172_800_000).toISOString(), endsAt: new Date(Date.now() + 176_400_000).toISOString() } as any);
      expect(prisma.session.update).not.toHaveBeenCalled();
      const call = prisma.session.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 's1', workspaceId: 'w1' });
      expect(call.data).not.toHaveProperty('notes');
      expect(call.data).not.toHaveProperty('internalSummary');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('guardar la historia con el marcador no escribe nada', async () => {
    const tx: any = { clinicalHistory: { updateMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() }, patient: { findFirst: jest.fn() }, auditLog: { create: jest.fn() } };
    const prisma: any = { ...tx, $transaction: jest.fn(async (cb: any) => cb(tx)) };
    const access: any = { assertPatientClinicalAccess: jest.fn(async () => ({ id: 'p1', status: 'ACTIVE' })) };
    await expect(new PatientCareService(prisma, access).updateClinicalHistory('w1', owner, 'p1', { currentProblem: DECRYPTION_FAILED_PLACEHOLDER, riskFactors: 'Texto ficticio' } as any))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tx.clinicalHistory.updateMany).not.toHaveBeenCalled();
    expect(tx.clinicalHistory.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('Recomendables: dashboard y notificaciones no exponen contenido clínico', () => {
  it('dashboard: sesiones sin notes/internalSummary y título de tarea descifrado', async () => {
    const prisma: any = {
      workspaceMember: { findFirst: jest.fn(async () => ({ role: 'OWNER', onboardingStep: 0, user: { firstName: 'A', lastName: 'B' } })), findUnique: jest.fn(async () => ({ role: 'OWNER', onboardingStep: 0, user: { firstName: 'A', lastName: 'B' } })) },
      session: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
      patient: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
      therapeuticTask: { findMany: jest.fn(async () => [{ id: 't1', title: encryptField('Tarea ficticia'), patient: { id: 'p1', firstName: 'P', lastName: 'F' } }]) },
      message: { findMany: jest.fn(async () => []) },
      notificationPreference: { findUnique: jest.fn(async () => null) },
    };
    const result: any = await new DashboardService(prisma).get(owner);
    const sessionArgs = prisma.session.findMany.mock.calls[0][0];
    expect(sessionArgs.include).toBeUndefined();
    expect(sessionArgs.select.notes).toBeUndefined();
    expect(sessionArgs.select.internalSummary).toBeUndefined();
    expect(prisma.therapeuticTask.findMany.mock.calls[0][0].select).toEqual({ id: true, title: true, patient: expect.anything() });
    expect(result.attention[0].subtitle).toBe('Tarea ficticia');
  });

  it('TASK_DUE y CONSENT_EXPIRING al paciente llevan un texto genérico, sin títulos', async () => {
    const soon = new Date(Date.now() + 3_600_000);
    const created: any[] = [];
    const prisma: any = {
      session: { findMany: jest.fn(async () => []) },
      therapeuticTask: { findMany: jest.fn(async () => [{ id: 't1', patientId: 'p1', title: 'Título ficticio de tarea', dueDate: soon, patient: { clinicalProcesses: [] } }]) },
      consentRecord: { findMany: jest.fn(async () => [{ id: 'c1', patientId: 'p1', title: 'Título ficticio de consentimiento', expiresAt: soon }]) },
      invoice: { findMany: jest.fn(async () => []) },
      notificationPreference: { findMany: jest.fn(async () => []) },
      notification: { createMany: jest.fn(async ({ data }: any) => { created.push(...data); return { count: data.length }; }) },
      auditLog: { create: jest.fn(async () => ({})) },
    };
    await new NotificationsService(prisma).processDue(owner);
    expect(prisma.therapeuticTask.findMany.mock.calls[0][0].select.title).toBeUndefined();
    expect(prisma.consentRecord.findMany.mock.calls[0][0].select.title).toBeUndefined();
    const types = created.map((n) => n.type).sort();
    expect(types).toEqual(['CONSENT_EXPIRING', 'TASK_DUE']);
    expect(JSON.stringify(created)).not.toContain('Título ficticio');
  });
});

describe('Exportación: el registro cubre todos los modelos de la ficha (sin rutas "fugadas")', () => {
  it('ningún campo cifrado llega a la red de seguridad con fixtures de todos los modelos', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { ENCRYPTED_TEXT_FIELDS, encryptJsonField } = await import('../src/common/crypto/clinical-crypto');
      const row = (model: keyof typeof ENCRYPTED_TEXT_FIELDS, extra: any = {}) => ({ id: `${model}-1`, ...extra, ...Object.fromEntries(ENCRYPTED_TEXT_FIELDS[model].map((f) => [f, encryptField(`${model}.${f} ficticio`)])) });
      const patient = {
        ...row('patient'), clinicalHistory: row('clinicalHistory'), clinicalProcesses: [row('clinicalProcess')], sessions: [row('session')],
        therapyGoals: [row('therapyGoal')], therapeuticTasks: [row('therapeuticTask', { therapyGoal: row('therapyGoal') })],
        clinicalAssessments: [row('clinicalAssessment', { answers: encryptJsonField([0, 1]) })], consentRecords: [row('consentRecord')],
        clinicalReports: [row('clinicalReport')], patientDocuments: [row('patientDocument')], invoices: [], resourceShares: [],
      };
      const prisma: any = {
        user: { findUnique: jest.fn().mockResolvedValue({ passwordHash: hashSync(PASSWORD, 4) }) },
        patient: { findFirst: jest.fn().mockResolvedValueOnce({ id: 'p1' }).mockResolvedValueOnce(patient) },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      };
      const result: any = await new ExportsService(prisma).exportPatient(owner, 'p1', PASSWORD);
      expect(warn).not.toHaveBeenCalled(); // leakedPaths.length === 0
      expect(JSON.stringify(result)).not.toMatch(/enc:v[12]:/);
    } finally {
      warn.mockRestore();
    }
  });
});
