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
    expect(source).toContain('this.lifecycle.changeStatus');
    expect(source).toContain('this.lifecycle.block');
  });

  it('keeps each extracted domain service below the agreed size ceiling', () => {
    const files = [
      'patient-access.service.ts',
      'patient-core.service.ts',
      'patient-care.service.ts',
      'patient-tasks.service.ts',
      'patient-assessments.service.ts',
      'patient-records.service.ts',
      'patient-lifecycle.service.ts',
    ];

    for (const file of files) {
      const lines = read(file).split(/\r?\n/).length;
      expect({ file, lines }).toEqual(expect.objectContaining({ file }));
      expect(lines).toBeLessThan(600);
    }
  });

  it('centralizes patient-level clinical authorization', () => {
    // La decisión vive en un único servicio (common a todos los módulos clínicos).
    const central = readFileSync(join(__dirname, '..', 'src', 'clinical-access', 'clinical-access.service.ts'), 'utf8');
    expect(central).toContain('assertPatientClinicalAccess');
    expect(central).toContain('isClinician');
    expect(central).toContain("status === 'ACTIVE'");
    expect(central).toContain('therapistId: actor.sub');
    expect(central).toContain('CLINICAL_ACCESS_DENIED');

    const access = read('patient-access.service.ts');
    expect(access).toContain('extends ClinicalAccessService');

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

  it('todos los módulos con contenido clínico deciden con ClinicalAccessService', () => {
    const src = join(__dirname, '..', 'src');
    for (const file of [
      'clinical-processes/clinical-processes.service.ts',
      'sessions/sessions.service.ts',
      'messages/messages.service.ts',
      'exports/exports.service.ts',
      'dashboard/dashboard.service.ts',
      'resources/resources.service.ts',
      'patients/patient-core.service.ts',
    ]) {
      expect({ file, usesCentral: readFileSync(join(src, file), 'utf8').includes('ClinicalAccessService') }).toEqual({ file, usesCentral: true });
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
      'PatientLifecycleService',
      'PatientsService',
    ]) {
      expect(moduleSource).toContain(service);
    }
  });
});
