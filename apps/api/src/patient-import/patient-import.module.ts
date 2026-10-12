import { Module } from '@nestjs/common';
import { PatientImportController } from './patient-import.controller';
import { PatientImportAccess } from './patient-import-access';
import { PatientImportCleanupService } from './patient-import-cleanup.service';
import { PatientImportConfirmService } from './patient-import-confirm.service';
import { PatientImportJobsService } from './patient-import-jobs.service';
import { PatientImportRevertService } from './patient-import-revert.service';
import { PatientImportService } from './patient-import.service';

/**
 * Importación de pacientes desde CSV/XLSX. Módulo aparte de `patients/` a propósito: no depende
 * de PatientsService y solo reutiliza utilidades sin estado (PHONE_REGEX, NON_MODIFIABLE_STATUSES).
 */
@Module({
  controllers: [PatientImportController],
  providers: [
    PatientImportAccess,
    PatientImportJobsService,
    PatientImportService,
    PatientImportConfirmService,
    PatientImportRevertService,
    PatientImportCleanupService,
  ],
})
export class PatientImportModule {}
