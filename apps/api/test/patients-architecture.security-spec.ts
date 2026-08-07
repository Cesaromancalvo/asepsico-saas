import { readFileSync } from 'fs';
import { join } from 'path';

const patientsDir = join(__dirname, '..', 'src', 'patients');
const read = (file: string) => readFileSync(join(patientsDir, file), 'utf8');

describe('Patients module architecture regression', () => {
  it('keeps PatientsService as a small compatibility facade', () => {
    const source = read('patients.service.ts');
    const lines = source.split(/\r?\n/).length;

    expect(lines).toBeLessThan(220);
    expect(source).toContain('extends PatientCoreService');
    expect(source).toContain('this.care.getClinicalHistory');
    expect(source).toContain('this.tasks.getTherapeuticTasks');
    expect(source).toContain('this.assessments.getClinicalAssessments');
    expect(source).toContain('this.records.getPatientDocuments');
  });

  it('keeps each extracted domain service below the agreed size ceiling', () => {
    const files = [
      'patient-access.service.ts',
      'patient-core.service.ts',
      'patient-care.service.ts',
      'patient-tasks.service.ts',
      'patient-assessments.service.ts',
      'patient-records.service.ts',
    ];

    for (const file of files) {
      const lines = read(file).split(/\r?\n/).length;
      expect({ file, lines }).toEqual(expect.objectContaining({ file }));
      expect(lines).toBeLessThan(600);
    }
  });

  it('centralizes patient-level clinical authorization', () => {
    const access = read('patient-access.service.ts');
    expect(access).toContain('assertPatientClinicalAccess');
    expect(access).toContain("actor.role === 'THERAPIST'");
    expect(access).toContain('therapistId: actor.sub');

    for (const file of [
      'patient-care.service.ts',
      'patient-tasks.service.ts',
      'patient-assessments.service.ts',
      'patient-records.service.ts',
    ]) {
      const source = read(file);
      expect(source).toContain('this.access.assertPatientClinicalAccess');
    }
  });

  it('registers all extracted services in PatientsModule', () => {
    const moduleSource = read('patients.module.ts');
    for (const service of [
      'PatientAccessService',
      'PatientCareService',
      'PatientTasksService',
      'PatientAssessmentsService',
      'PatientRecordsService',
      'PatientsService',
    ]) {
      expect(moduleSource).toContain(service);
    }
  });
});
